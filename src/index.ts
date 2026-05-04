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

const MAGO_PATH = process.env.MAGO_PATH || "mago";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MethodInfo {
  name: string;
  visibility: string;
  start_line: number;
  end_line: number;
  params: string[];
  return_type: string | null;
}

interface PropertyInfo {
  name: string;
  visibility: string;
  type: string | null;
}

interface ClassInfo {
  class: string;
  namespace: string | null;
  extends: string | null;
  methods: MethodInfo[];
  properties: PropertyInfo[];
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
// Mago AST span helpers
//
// Mago span format: { file_id: N, start: { offset: N }, end: { offset: N } }
// Token span (no file_id): same shape, just missing file_id
// ---------------------------------------------------------------------------

type SpanRange = { start: number; end: number };

function getMagoSpanRange(spanLike: unknown): SpanRange | null {
  if (!spanLike || typeof spanLike !== "object") return null;
  const s = spanLike as Record<string, unknown>;
  const startObj = s.start as Record<string, unknown> | undefined;
  const endObj = s.end as Record<string, unknown> | undefined;
  if (
    startObj && typeof startObj.offset === "number" &&
    endObj && typeof endObj.offset === "number"
  ) {
    return { start: startObj.offset, end: endObj.offset };
  }
  return null;
}

// Node that carries a .span sub-field, e.g. { span: {...}, value: "Foo" }
function getNodeSpan(node: Record<string, unknown>): SpanRange | null {
  if (node.span) return getMagoSpanRange(node.span);
  return getMagoSpanRange(node); // token IS the span
}

// ---------------------------------------------------------------------------
// Mago value-node helpers
// Node pattern: { type: "TypeName", value: { ... } }
// ---------------------------------------------------------------------------

function nodeValue(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  if (n.value && typeof n.value === "object" && !Array.isArray(n.value)) {
    return n.value as Record<string, unknown>;
  }
  return null;
}

function nodeType(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string") return n.type;
  return null;
}

function nodesOf(container: unknown): unknown[] {
  if (!container || typeof container !== "object") return [];
  const c = container as Record<string, unknown>;
  if (Array.isArray(c.nodes)) return c.nodes;
  return [];
}

// ---------------------------------------------------------------------------
// Name / string extraction
// ---------------------------------------------------------------------------

function extractMagoName(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (!val || typeof val !== "object") return null;
  const v = val as Record<string, unknown>;
  // { span: {...}, value: "Foo" }
  if (typeof v.value === "string") return v.value;
  // { span: {...}, name: "$name" } (variable nodes)
  if (typeof v.name === "string") return v.name;
  return null;
}

// ---------------------------------------------------------------------------
// Type hint extraction
// Mago type hints: { type: "Void"|"String"|...|"Local"|"Named"|"Nullable"|"Union"|..., value: {...} }
// ---------------------------------------------------------------------------

const BUILTIN_TYPE_KINDS = new Set([
  "Void", "String", "Int", "Integer", "Float", "Bool", "Boolean",
  "Array", "Object", "Mixed", "Never", "Null", "False", "True",
  "Static", "Self", "Parent", "Iterable", "Callable",
]);

const NAMED_TYPE_KINDS = new Set(["Local", "Named", "FullyQualified", "Qualified"]);

function extractMagoTypeHint(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const kind = nodeType(node);
  if (!kind) return null;
  const inner = nodeValue(node);

  // Built-in scalar/special types — value contains { span, value: "string" }
  if (BUILTIN_TYPE_KINDS.has(kind)) {
    if (inner && typeof inner.value === "string") return inner.value;
    return kind.toLowerCase();
  }

  // Named / Local / FullyQualified / Qualified
  if (NAMED_TYPE_KINDS.has(kind) && inner && typeof inner.value === "string") {
    return inner.value;
  }

  if (!inner) return null;

  // Identifier wraps a Local/Named node
  if (kind === "Identifier") return extractMagoTypeHint(inner);

  // Nullable: { type: "Nullable", value: { hint: {...} } }
  if (kind === "Nullable") {
    const hint = extractMagoTypeHint(inner.hint);
    return hint ? "?" + hint : null;
  }

  // Union / Intersection: { type: "Union", value: { types: { nodes: [...] } } }
  if (kind === "Union" || kind === "Intersection") {
    const separator = kind === "Union" ? "|" : "&";
    const parts = nodesOf(inner.types).map(extractMagoTypeHint).filter(Boolean);
    return parts.length > 0 ? parts.join(separator) : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Extends / implements extraction
// { type: "Local"|"Named"|..., value: { span: {...}, value: "Bar" } }
// ---------------------------------------------------------------------------

function extractMagoFqn(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  const kind = nodeType(n);
  const inner = nodeValue(n);
  if (inner && typeof inner.value === "string") return inner.value;
  if (inner) {
    // Qualified: { parts: { nodes: [{ span: {...}, value: "App" }, ...] } }
    const parts = nodesOf(inner.parts);
    if (parts.length > 0) {
      return parts.map(extractMagoName).filter(Boolean).join("\\");
    }
  }
  if (kind && typeof kind === "string") return kind; // fallback
  return null;
}

function extractImplementsList(typesContainer: unknown): string[] {
  return nodesOf(typesContainer)
    .map(extractMagoFqn)
    .filter((s): s is string => s !== null);
}

// ---------------------------------------------------------------------------
// Visibility / modifiers
// Modifiers are { type: "Public"|"Private"|"Protected"|"Static"|"Abstract"|..., value: {...} }
// ---------------------------------------------------------------------------

function extractModifiers(modifiersContainer: unknown): string[] {
  return nodesOf(modifiersContainer)
    .map(nodeType)
    .filter((t): t is string => t !== null)
    .map((t) => t.toLowerCase());
}

function extractVisibilityFromModifiers(modifiers: string[]): string {
  for (const m of modifiers) {
    if (m === "public" || m === "protected" || m === "private") return m;
  }
  return "public";
}

// ---------------------------------------------------------------------------
// Parameter extraction
// Parameter node (not wrapped in type/value): { hint: {...}, variable: { span: {...}, name: "$foo" }, default_value: null }
// ---------------------------------------------------------------------------

function extractMagoParameters(paramListNode: unknown): string[] {
  if (!paramListNode || typeof paramListNode !== "object") return [];
  const pl = paramListNode as Record<string, unknown>;

  const params = nodesOf(pl.parameters);
  if (params.length > 0) return parseParamNodes(params);

  // Fallback: parameter list might be a bare { nodes: [...] } container
  return parseParamNodes(nodesOf(pl));
}

function parseParamNodes(nodes: unknown[]): string[] {
  return nodes
    .map((p): string | null => {
      if (!p || typeof p !== "object") return null;
      const param = p as Record<string, unknown>;

      const name = extractMagoName(param.variable) ?? "?";
      const type = extractMagoTypeHint(param.hint ?? param.type_hint ?? param.type ?? null);
      const hasDefault = param.default_value !== null && param.default_value !== undefined;

      let result = type ? `${type} ${name}` : name;
      if (hasDefault) result += " = ...";
      return result;
    })
    .filter((p): p is string => p !== null);
}

// ---------------------------------------------------------------------------
// Method extraction from class members list
// ---------------------------------------------------------------------------

const METHOD_TYPES = new Set(["Method", "AbstractMethod", "ConcreteMethod"]);

function extractMagoMethods(membersContainer: unknown, lineIndex: number[]): MethodInfo[] {
  const methods: MethodInfo[] = [];

  for (const member of nodesOf(membersContainer)) {
    const kind = nodeType(member);
    if (!kind || !METHOD_TYPES.has(kind)) continue;

    const methodValue = nodeValue(member);
    if (!methodValue) continue;

    const modifiers = extractModifiers(methodValue.modifiers);
    const name = extractMagoName(methodValue.name) ?? "<anonymous>";

    // Start line: first modifier span, or the `function` keyword span
    let startOffset: number | null = null;
    const firstModifier = nodesOf(methodValue.modifiers)[0];
    if (firstModifier) {
      const mv = nodeValue(firstModifier);
      if (mv) {
        const s = getNodeSpan(mv);
        if (s) startOffset = s.start;
      }
    }
    if (startOffset === null && methodValue.function) {
      const fnSpan = getNodeSpan(methodValue.function as Record<string, unknown>);
      if (fnSpan) startOffset = fnSpan.start;
    }

    // End line: body's right_brace or semicolon
    let endOffset: number | null = null;
    const body = methodValue.body;
    if (body && typeof body === "object") {
      const bodyKind = nodeType(body);
      const bodyVal = nodeValue(body as Record<string, unknown>);
      if (bodyVal) {
        const rb = getNodeSpan(bodyVal.right_brace as Record<string, unknown>);
        if (rb) endOffset = rb.end;
        if (endOffset === null) {
          const semi = getNodeSpan(bodyVal.semicolon as Record<string, unknown>);
          if (semi) endOffset = semi.end;
        }
      }
    }
    // If still no end, use the name span end as fallback
    if (endOffset === null) {
      const nameSpan = getNodeSpan(methodValue.name as Record<string, unknown>);
      if (nameSpan) endOffset = nameSpan.end;
    }

    if (startOffset === null || endOffset === null) continue;

    const returnTypeNode = methodValue.return_type_hint;
    let returnType: string | null = null;
    if (returnTypeNode && typeof returnTypeNode === "object") {
      const rtn = returnTypeNode as Record<string, unknown>;
      returnType = extractMagoTypeHint(rtn.hint);
    }

    const params = extractMagoParameters(methodValue.parameter_list);

    methods.push({
      name,
      visibility: extractVisibilityFromModifiers(modifiers),
      start_line: offsetToLine(lineIndex, startOffset),
      end_line: offsetToLine(lineIndex, endOffset),
      params,
      return_type: returnType,
    });
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Property extraction from class members list
// Property node: { type: "Property", value: { type: "Plain", value: { modifiers, hint, items } } }
// ---------------------------------------------------------------------------

function extractMagoProperties(membersContainer: unknown): PropertyInfo[] {
  const properties: PropertyInfo[] = [];

  for (const member of nodesOf(membersContainer)) {
    if (nodeType(member) !== "Property") continue;

    const outerValue = nodeValue(member);
    if (!outerValue) continue;

    // Double-wrapped: { type: "Property", value: { type: "Plain", value: { ... } } }
    const propValue = nodeValue(outerValue) ?? outerValue;

    const modifiers = extractModifiers(propValue.modifiers);
    const visibility = extractVisibilityFromModifiers(modifiers);
    const type = extractMagoTypeHint(propValue.hint ?? null);

    for (const item of nodesOf(propValue.items)) {
      if (!item || typeof item !== "object") continue;
      const itemVal = nodeValue(item) ?? (item as Record<string, unknown>);
      const name = extractMagoName(itemVal.variable) ?? "?";
      properties.push({ name, visibility, type });
    }
  }

  return properties;
}

// ---------------------------------------------------------------------------
// Class-like node detection
// ---------------------------------------------------------------------------

const CLASS_LIKE_TYPES = new Set([
  "Class", "Interface", "Trait", "Enum",
  "ClassDeclaration", "InterfaceDeclaration", "TraitDeclaration", "EnumDeclaration",
]);

// ---------------------------------------------------------------------------
// Main AST traversal — collect all class-like declarations
// Recursively walks statement lists, following namespace bodies.
// ---------------------------------------------------------------------------

function collectClasses(
  statementNodes: unknown[],
  lineIndex: number[],
  currentNamespace: string | null = null,
  methodFilter: string | null = null
): ClassInfo[] {
  const results: ClassInfo[] = [];

  for (const stmt of statementNodes) {
    const kind = nodeType(stmt);
    if (!kind) continue;

    // Namespace statement: recurse into body
    if (kind === "Namespace" || kind === "NamespaceDeclaration" || kind === "NamespaceStatement") {
      const nsValue = nodeValue(stmt);
      if (!nsValue) continue;

      const nsName = extractMagoFqn(nsValue.name) ?? currentNamespace;

      // Body can be Implicit (semicolon-terminated) or Explicit (braced)
      const bodyVal = nodeValue(nsValue.body);
      if (!bodyVal) continue;

      const bodyStatements = nodesOf(bodyVal.statements);
      results.push(...collectClasses(bodyStatements, lineIndex, nsName, methodFilter));
      continue;
    }

    // Class-like declaration
    if (CLASS_LIKE_TYPES.has(kind)) {
      const classValue = nodeValue(stmt);
      if (!classValue) continue;

      const className = extractMagoName(classValue.name);
      if (!className) continue;

      let extendsName: string | null = null;
      if (classValue.extends && typeof classValue.extends === "object") {
        const extendsObj = classValue.extends as Record<string, unknown>;
        const extendsNodes = nodesOf(extendsObj.types);
        if (extendsNodes.length > 0) extendsName = extractMagoFqn(extendsNodes[0]);
      }

      let methods = extractMagoMethods(classValue.members, lineIndex);
      if (methodFilter) methods = methods.filter((m) => m.name === methodFilter);

      const properties = extractMagoProperties(classValue.members);

      results.push({
        class: className,
        namespace: currentNamespace,
        extends: extendsName,
        methods,
        properties,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool: get_class_structure
// ---------------------------------------------------------------------------

function getClassStructure(filePath: string, methodFilter: string | null = null): ClassInfo[] {
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

  // Top-level: { program: { statements: { nodes: [...] } } }
  const prog = (ast as Record<string, unknown>).program as Record<string, unknown> | undefined;
  if (!prog) throw new Error("Unexpected mago AST shape: missing 'program' key.");

  const topNodes = nodesOf(prog.statements);
  return collectClasses(topNodes, lineIndex, null, methodFilter);
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
  const normalized = className.replace(/^\\/, "");

  const classmapPath = path.join(projectRoot, "vendor/composer/autoload_classmap.php");
  if (fs.existsSync(classmapPath)) {
    const content = fs.readFileSync(classmapPath, "utf8");
    const pattern = new RegExp(
      `'${escapeRegex(normalized)}'\\s*=>\\s*\\$(?:baseDir|vendorDir)\\s*\\.\\s*'([^']+)'`
    );
    const match = pattern.exec(content);
    if (match) {
      return path.resolve(projectRoot, match[1].replace(/^\//, ""));
    }
  }

  const psr4Path = path.join(projectRoot, "vendor/composer/autoload_psr4.php");
  if (fs.existsSync(psr4Path)) {
    const content = fs.readFileSync(psr4Path, "utf8");
    const entryPattern = /'([^']+)'\s*=>\s*array\s*\(\s*\$(?:baseDir|vendorDir)\s*\.\s*'([^']+)'/g;
    let entryMatch: RegExpExecArray | null;
    const mappings: Array<{ prefix: string; dir: string }> = [];
    while ((entryMatch = entryPattern.exec(content)) !== null) {
      mappings.push({ prefix: entryMatch[1], dir: entryMatch[2].replace(/^\//, "") });
    }
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
// Tool: debug_ast
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
        "Use this BEFORE reading any PHP file. Returns all classes/interfaces/traits/enums with " +
        "method stubs (name, visibility, params, return type, line range) and properties. " +
        "Pass method_name to get only that one method's stub. Use read_lines to read the body. " +
        "Requires mago to be installed (set MAGO_PATH env var if not on PATH).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the PHP file" },
          method_name: {
            type: "string",
            description: "Optional: return only the stub for this method name",
          },
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

const GetClassStructureInput = z.object({
  file_path: z.string(),
  method_name: z.string().optional(),
});
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
        const { file_path, method_name } = GetClassStructureInput.parse(args);
        const classes = getClassStructure(file_path, method_name ?? null);
        return { content: [{ type: "text", text: JSON.stringify(classes) }] };
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
