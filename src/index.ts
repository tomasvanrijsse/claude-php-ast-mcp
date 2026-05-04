import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Configurable via env — mago may not be on PATH when Claude Code spawns the server
const MAGO_PATH = process.env.MAGO_PATH || "mago";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParameterInfo {
  name: string;
  type: string | null;
  has_default: boolean;
}

interface MethodInfo {
  name: string;
  visibility: string;
  is_static: boolean;
  is_abstract: boolean;
  start_line: number;
  end_line: number;
  parameters: ParameterInfo[];
  return_type: string | null;
}

interface ClassInfo {
  name: string;
  type: "class" | "interface" | "trait" | "enum";
  namespace: string | null;
  extends: string | null;
  implements: string[];
  start_line: number;
  end_line: number;
  methods: MethodInfo[];
}

// ---------------------------------------------------------------------------
// Line index — converts byte offset → 1-based line number
// ---------------------------------------------------------------------------

function buildLineIndex(source: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(lineIndex: number[], offset: number): number {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (lineIndex[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// Span / position extraction helpers
// ---------------------------------------------------------------------------

function extractSpan(node: Record<string, unknown>): { start: number; end: number } | null {
  // mago uses Span { start: ByteOffset, end: ByteOffset }
  // ByteOffset serialises as a plain number
  if (
    node.span &&
    typeof (node.span as Record<string, unknown>).start === "number" &&
    typeof (node.span as Record<string, unknown>).end === "number"
  ) {
    const s = node.span as Record<string, unknown>;
    return { start: s.start as number, end: s.end as number };
  }
  // Common alternative field names
  for (const key of ["position", "loc", "range"]) {
    const v = node[key] as Record<string, unknown> | undefined;
    if (v && typeof v.start === "number" && typeof v.end === "number") {
      return { start: v.start, end: v.end };
    }
  }
  if (typeof node.start === "number" && typeof node.end === "number") {
    return { start: node.start as number, end: node.end as number };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Name extraction — handles both plain strings and {value:"..."} objects
// ---------------------------------------------------------------------------

function extractName(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (val && typeof val === "object") {
    const v = val as Record<string, unknown>;
    if (typeof v.value === "string") return v.value;
    if (typeof v.name === "string") return v.name;
    // mago identifier nodes may carry the text via a nested object
    for (const key of Object.keys(v)) {
      const child = v[key];
      if (typeof child === "string" && child.length > 0 && /^\w/.test(child)) return child;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AST node type detection
// ---------------------------------------------------------------------------

// mago serialises enums with external tagging by default: {"ClassName": {...}}
// but some nodes carry an explicit "kind" or "type" field.
function getNodeKind(node: Record<string, unknown>): string | null {
  if (typeof node.kind === "string") return node.kind;
  if (typeof node.type === "string") return node.type;
  if (typeof node.nodeType === "string") return node.nodeType;
  // External tagging: single-key objects whose key is a PascalCase identifier
  const keys = Object.keys(node);
  if (keys.length === 1 && /^[A-Z]/.test(keys[0])) return keys[0];
  return null;
}

const CLASS_LIKE_KINDS = new Set([
  "ClassDeclaration", "Class",
  "InterfaceDeclaration", "Interface",
  "TraitDeclaration", "Trait",
  "EnumDeclaration", "Enum",
  "AnonymousClass",
]);

const METHOD_LIKE_KINDS = new Set([
  "Method", "ClassMethod", "MethodDeclaration",
  "AbstractMethod", "ConcreteMethod",
  "Constructor", "Destructor",
]);

function isClassLike(kind: string): boolean {
  if (CLASS_LIKE_KINDS.has(kind)) return true;
  const lower = kind.toLowerCase();
  return (
    (lower.includes("class") || lower.includes("interface") ||
     lower.includes("trait") || lower.includes("enum")) &&
    !lower.includes("method") && !lower.includes("member")
  );
}

function isMethodLike(kind: string): boolean {
  if (METHOD_LIKE_KINDS.has(kind)) return true;
  const lower = kind.toLowerCase();
  return lower.includes("method") || lower.includes("function");
}

// ---------------------------------------------------------------------------
// Visibility extraction
// ---------------------------------------------------------------------------

function extractVisibility(node: Record<string, unknown>): string {
  // mago stores modifiers in a "modifiers" array or as boolean flags
  const modifiers = node.modifiers;
  if (Array.isArray(modifiers)) {
    for (const m of modifiers) {
      const s = typeof m === "string" ? m.toLowerCase() : extractName(m)?.toLowerCase() ?? "";
      if (s === "public" || s === "protected" || s === "private") return s;
    }
  }
  // Flat boolean flags
  if (node.public === true || node.is_public === true) return "public";
  if (node.protected === true || node.is_protected === true) return "protected";
  if (node.private === true || node.is_private === true) return "private";
  // Check flags field
  if (node.flags && typeof node.flags === "object") {
    const f = node.flags as Record<string, unknown>;
    if (f.public) return "public";
    if (f.protected) return "protected";
    if (f.private) return "private";
  }
  return "public"; // PHP default for interface methods
}

function isStatic(node: Record<string, unknown>): boolean {
  if (node.is_static === true) return true;
  if (node.static === true) return true;
  const modifiers = node.modifiers;
  if (Array.isArray(modifiers)) {
    return modifiers.some((m) => {
      const s = typeof m === "string" ? m.toLowerCase() : extractName(m)?.toLowerCase() ?? "";
      return s === "static";
    });
  }
  return false;
}

function isAbstract(node: Record<string, unknown>): boolean {
  if (node.is_abstract === true) return true;
  if (node.abstract === true) return true;
  const modifiers = node.modifiers;
  if (Array.isArray(modifiers)) {
    return modifiers.some((m) => {
      const s = typeof m === "string" ? m.toLowerCase() : extractName(m)?.toLowerCase() ?? "";
      return s === "abstract";
    });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Type hint extraction
// ---------------------------------------------------------------------------

function extractTypeHint(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    const v = val as Record<string, unknown>;
    const name = extractName(v);
    if (name) return name;
    // Union / intersection types
    if (Array.isArray(v.types)) {
      return (v.types as unknown[]).map(extractTypeHint).filter(Boolean).join("|");
    }
    if (Array.isArray(v.items)) {
      return (v.items as unknown[]).map(extractTypeHint).filter(Boolean).join("|");
    }
    // Nullable: ?T
    if (v.nullable === true && v.type) {
      return "?" + (extractTypeHint(v.type) ?? "mixed");
    }
    if (v.inner || v.hint) return extractTypeHint(v.inner ?? v.hint);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

function extractParameters(raw: unknown): ParameterInfo[] {
  if (!raw) return [];
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).items)
    ? ((raw as Record<string, unknown>).items as unknown[])
    : [];

  return list
    .map((p): ParameterInfo | null => {
      if (!p || typeof p !== "object") return null;
      const param = p as Record<string, unknown>;
      // Name field might be "$foo" or just "foo"
      let name =
        extractName(param.name ?? param.variable ?? param.var) ?? "?";
      if (!name.startsWith("$")) name = "$" + name;
      const type = extractTypeHint(param.type ?? param.type_hint ?? param.hint ?? null);
      return { name, type, has_default: param.default != null || param.has_default === true };
    })
    .filter((p): p is ParameterInfo => p !== null);
}

// ---------------------------------------------------------------------------
// Method extraction from a class-body subtree
// ---------------------------------------------------------------------------

function extractMethods(
  bodyNode: unknown,
  lineIndex: number[]
): MethodInfo[] {
  const methods: MethodInfo[] = [];
  if (!bodyNode || typeof bodyNode !== "object") return methods;

  // Find the members/methods array — it may be nested one level under "body" key
  const candidates: unknown[] = [];
  const body = bodyNode as Record<string, unknown>;

  for (const key of ["members", "items", "statements", "body", "methods"]) {
    if (Array.isArray(body[key])) {
      candidates.push(...(body[key] as unknown[]));
    }
  }
  // Also recurse if body wraps another object
  if (candidates.length === 0) {
    for (const v of Object.values(body)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        return extractMethods(v, lineIndex);
      }
    }
  }

  for (const member of candidates) {
    if (!member || typeof member !== "object") continue;
    let memberNode = member as Record<string, unknown>;

    // Handle external tagging: {"Method": {...}} or {"ConcreteMethod": {...}}
    const kind = getNodeKind(memberNode);
    if (kind) {
      if (!isMethodLike(kind)) continue;
      // Unwrap externally tagged nodes
      if (
        Object.keys(memberNode).length === 1 &&
        typeof memberNode[kind] === "object"
      ) {
        memberNode = memberNode[kind] as Record<string, unknown>;
      }
    } else {
      // No kind — only proceed if it has a name that looks like a method
      if (!memberNode.name && !memberNode.identifier) continue;
    }

    const span = extractSpan(memberNode);
    if (!span) continue;

    const name = extractName(memberNode.name ?? memberNode.identifier) ?? "<anonymous>";
    const returnType = extractTypeHint(
      memberNode.return_type ?? memberNode.returnType ?? memberNode.returns ?? null
    );
    const parameters = extractParameters(
      memberNode.parameters ?? memberNode.params ?? memberNode.arguments ?? null
    );

    methods.push({
      name,
      visibility: extractVisibility(memberNode),
      is_static: isStatic(memberNode),
      is_abstract: isAbstract(memberNode),
      start_line: offsetToLine(lineIndex, span.start),
      end_line: offsetToLine(lineIndex, span.end),
      parameters,
      return_type: returnType,
    });
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Fqn (fully qualified name) helpers for extends/implements
// ---------------------------------------------------------------------------

function extractFqn(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    const v = val as Record<string, unknown>;
    // mago: { parts: ["App", "Models", "User"] }
    if (Array.isArray(v.parts)) {
      return (v.parts as unknown[]).map((p) => extractName(p) ?? String(p)).join("\\\\");
    }
    const name = extractName(v);
    if (name) return name;
    if (v.name) return extractFqn(v.name);
  }
  return null;
}

function extractImplementsList(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(extractFqn).filter((s): s is string => s !== null);
  if (typeof val === "object") {
    const v = val as Record<string, unknown>;
    for (const key of ["interfaces", "items", "list"]) {
      if (Array.isArray(v[key])) {
        return (v[key] as unknown[]).map(extractFqn).filter((s): s is string => s !== null);
      }
    }
    const name = extractFqn(v);
    if (name) return [name];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main AST traversal — collect all class-like declarations
// ---------------------------------------------------------------------------

function collectClasses(
  node: unknown,
  lineIndex: number[],
  currentNamespace: string | null = null
): ClassInfo[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    return node.flatMap((child) => collectClasses(child, lineIndex, currentNamespace));
  }

  const results: ClassInfo[] = [];
  const obj = node as Record<string, unknown>;

  const kind = getNodeKind(obj);

  // Track namespace context
  if (kind === "Namespace" || kind === "NamespaceDeclaration" || kind === "NamespaceStatement") {
    const nsName = extractFqn(obj.name ?? obj.identifier ?? obj.namespace) ?? currentNamespace;
    // Recurse into namespace body
    for (const val of Object.values(obj)) {
      results.push(...collectClasses(val, lineIndex, nsName));
    }
    return results;
  }

  // Class-like node
  if (kind && isClassLike(kind)) {
    // Unwrap externally tagged node if needed
    let classNode = obj;
    if (Object.keys(obj).length === 1 && typeof obj[kind] === "object" && obj[kind] !== null) {
      classNode = obj[kind] as Record<string, unknown>;
    }

    const span = extractSpan(classNode);
    const className = extractName(classNode.name ?? classNode.identifier);
    if (className && span) {
      const classType = kind.toLowerCase().includes("interface")
        ? "interface"
        : kind.toLowerCase().includes("trait")
        ? "trait"
        : kind.toLowerCase().includes("enum")
        ? "enum"
        : "class";

      // Namespace may be declared on the class itself in some AST formats
      const ns =
        extractFqn(classNode.namespace ?? classNode.namespaceName) ??
        currentNamespace;

      const extendsName = extractFqn(
        classNode.extends ?? classNode.parent ?? classNode.base_class ?? null
      );
      const implementsList = extractImplementsList(
        classNode.implements ?? classNode.interfaces ?? null
      );

      const bodyKey = classNode.body ?? classNode.members ?? classNode.items;
      const methods = extractMethods(bodyKey, lineIndex);

      results.push({
        name: className,
        type: classType as ClassInfo["type"],
        namespace: ns,
        extends: extendsName,
        implements: implementsList,
        start_line: offsetToLine(lineIndex, span.start),
        end_line: offsetToLine(lineIndex, span.end),
        methods,
      });
    }
    // Still recurse for nested classes (rare but valid PHP)
  }

  // Recurse into all object values
  for (const val of Object.values(obj)) {
    results.push(...collectClasses(val, lineIndex, currentNamespace));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool: get_class_structure
// ---------------------------------------------------------------------------

function getClassStructure(filePath: string): ClassInfo[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const source = fs.readFileSync(filePath, "utf8");
  const lineIndex = buildLineIndex(source);

  let astJson: string;
  try {
    astJson = execFileSync(MAGO_PATH, ["ast", "--json", filePath], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to run mago (path: ${MAGO_PATH}). ` +
        `Set MAGO_PATH env var to the absolute path of mago.\n${msg}`
    );
  }

  let ast: unknown;
  try {
    ast = JSON.parse(astJson);
  } catch {
    throw new Error("mago produced invalid JSON. Check mago version and --json flag support.");
  }

  return collectClasses(ast, lineIndex);
}

// ---------------------------------------------------------------------------
// Tool: read_lines
// ---------------------------------------------------------------------------

function readLines(filePath: string, startLine: number, endLine: number): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const total = lines.length;
  const from = Math.max(1, startLine);
  const to = Math.min(total, endLine);
  return lines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}: ${line}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tool: find_class_file
// ---------------------------------------------------------------------------

function findClassFile(className: string, projectRoot: string): string {
  // Normalise: leading backslash is optional
  const normalized = className.replace(/^\\/,  "");

  const classmapPath = path.join(projectRoot, "vendor/composer/autoload_classmap.php");
  if (fs.existsSync(classmapPath)) {
    const content = fs.readFileSync(classmapPath, "utf8");
    // Match both $baseDir and $vendorDir variable prefixes
    const pattern = new RegExp(
      `'${escapeRegex(normalized)}'\\s*=>\\s*\\$(?:baseDir|vendorDir)\\s*\\.\\s*'([^']+)'`
    );
    const match = pattern.exec(content);
    if (match) {
      // Resolve relative to the project root (baseDir = projectRoot)
      return path.resolve(projectRoot, match[1].replace(/^\//, ""));
    }
  }

  // PSR-4 fallback
  const psr4Path = path.join(projectRoot, "vendor/composer/autoload_psr4.php");
  if (fs.existsSync(psr4Path)) {
    const content = fs.readFileSync(psr4Path, "utf8");
    // Extract entries: 'Namespace\\' => array($baseDir . '/src')
    const entryPattern = /'([^']+)'\s*=>\s*array\s*\(\s*\$(?:baseDir|vendorDir)\s*\.\s*'([^']+)'/g;
    let entryMatch: RegExpExecArray | null;
    const mappings: Array<{ prefix: string; dir: string }> = [];
    while ((entryMatch = entryPattern.exec(content)) !== null) {
      mappings.push({ prefix: entryMatch[1], dir: entryMatch[2].replace(/^\//, "") });
    }
    // Sort by prefix length descending for most-specific match first
    mappings.sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { prefix, dir } of mappings) {
      const p = prefix.replace(/\\$/, "\\\\");
      if (normalized.startsWith(p)) {
        const relative = normalized.slice(p.length).replace(/\\/g, "/");
        const candidate = path.join(projectRoot, dir, relative + ".php");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  throw new Error(
    `Class '${className}' not found in Composer autoload maps under '${projectRoot}'.`
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Tool: debug_ast — shows raw AST excerpt for troubleshooting
// ---------------------------------------------------------------------------

function debugAst(filePath: string): string {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  let astJson: string;
  try {
    astJson = execFileSync(MAGO_PATH, ["ast", "--json", filePath], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to run mago: ${msg}`);
  }

  // Return first 4 KB to avoid flooding the context
  return astJson.length > 4096 ? astJson.slice(0, 4096) + "\n… (truncated)" : astJson;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "php-structure", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_class_structure",
      description:
        "Use this BEFORE reading any PHP file. Returns all classes, interfaces, traits and enums " +
        "with their methods and line numbers so you can read only the relevant method with read_lines. " +
        "Requires mago to be installed (set MAGO_PATH env var if not on PATH).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the PHP file" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "read_lines",
      description:
        "Read a specific line range from any file. Use after get_class_structure to read only " +
        "the method you care about instead of loading the whole file.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          start_line: { type: "number", description: "First line to read (1-based, inclusive)" },
          end_line: { type: "number", description: "Last line to read (1-based, inclusive)" },
        },
        required: ["file_path", "start_line", "end_line"],
      },
    },
    {
      name: "find_class_file",
      description:
        "Find the absolute file path for a PHP class by name using Composer's autoload maps. " +
        "Use this instead of manually searching for a class file.",
      inputSchema: {
        type: "object",
        properties: {
          class_name: {
            type: "string",
            description: "Fully qualified class name, e.g. App\\\\Models\\\\User",
          },
          project_root: {
            type: "string",
            description: "Absolute path to the project root (where vendor/ lives)",
          },
        },
        required: ["class_name", "project_root"],
      },
    },
    {
      name: "debug_ast",
      description:
        "Returns the raw mago AST JSON (first 4 KB) for a PHP file. " +
        "Use this to inspect the AST structure when get_class_structure returns unexpected results.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the PHP file" },
        },
        required: ["file_path"],
      },
    },
  ],
}));

// Input schemas for validation
const GetClassStructureInput = z.object({ file_path: z.string() });
const ReadLinesInput = z.object({
  file_path: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
});
const FindClassFileInput = z.object({ class_name: z.string(), project_root: z.string() });
const DebugAstInput = z.object({ file_path: z.string() });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_class_structure": {
        const { file_path } = GetClassStructureInput.parse(args);
        const classes = getClassStructure(file_path);
        return { content: [{ type: "text", text: JSON.stringify(classes, null, 2) }] };
      }

      case "read_lines": {
        const { file_path, start_line, end_line } = ReadLinesInput.parse(args);
        const content = readLines(file_path, start_line, end_line);
        return { content: [{ type: "text", text: content }] };
      }

      case "find_class_file": {
        const { class_name, project_root } = FindClassFileInput.parse(args);
        const filePath = findClassFile(class_name, project_root);
        return { content: [{ type: "text", text: filePath }] };
      }

      case "debug_ast": {
        const { file_path } = DebugAstInput.parse(args);
        const output = debugAst(file_path);
        return { content: [{ type: "text", text: output }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("php-structure MCP server running (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
