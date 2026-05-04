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

interface MethodOutline {
  name: string;
  start_line: number;
  end_line: number;
}

interface ClassOutline {
  class: string;
  namespace: string | null;
  extends: string | null;
  implements: string[];
  methods: MethodOutline[];
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

function getNodeSpan(node: Record<string, unknown>): SpanRange | null {
  if (node.span) return getMagoSpanRange(node.span);
  return getMagoSpanRange(node);
}

// ---------------------------------------------------------------------------
// Mago value-node helpers
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
// Name / FQN extraction
// ---------------------------------------------------------------------------

function extractMagoName(val: unknown): string | null {
  if (typeof val === "string") return val;
  if (!val || typeof val !== "object") return null;
  const v = val as Record<string, unknown>;
  if (typeof v.value === "string") return v.value;
  if (typeof v.name === "string") return v.name;
  return null;
}

function extractMagoFqn(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  const kind = nodeType(n);
  const inner = nodeValue(n);
  if (inner && typeof inner.value === "string") return inner.value;
  if (inner) {
    const parts = nodesOf(inner.parts);
    if (parts.length > 0) {
      return parts.map(extractMagoName).filter(Boolean).join("\\");
    }
  }
  if (kind && typeof kind === "string") return kind;
  return null;
}

function extractImplementsList(typesContainer: unknown): string[] {
  return nodesOf(typesContainer)
    .map(extractMagoFqn)
    .filter((s): s is string => s !== null);
}

// ---------------------------------------------------------------------------
// Method outline extraction — name + line range only
// ---------------------------------------------------------------------------

const METHOD_TYPES = new Set(["Method", "AbstractMethod", "ConcreteMethod"]);

function extractMagoMethods(membersContainer: unknown, lineIndex: number[]): MethodOutline[] {
  const methods: MethodOutline[] = [];

  for (const member of nodesOf(membersContainer)) {
    const kind = nodeType(member);
    if (!kind || !METHOD_TYPES.has(kind)) continue;

    const methodValue = nodeValue(member);
    if (!methodValue) continue;

    const name = extractMagoName(methodValue.name) ?? "<anonymous>";

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

    let endOffset: number | null = null;
    const body = methodValue.body;
    if (body && typeof body === "object") {
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
    if (endOffset === null) {
      const nameSpan = getNodeSpan(methodValue.name as Record<string, unknown>);
      if (nameSpan) endOffset = nameSpan.end;
    }

    if (startOffset === null || endOffset === null) continue;

    methods.push({
      name,
      start_line: offsetToLine(lineIndex, startOffset),
      end_line: offsetToLine(lineIndex, endOffset),
    });
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Class-like node detection
// ---------------------------------------------------------------------------

const CLASS_LIKE_TYPES = new Set([
  "Class", "Interface", "Trait", "Enum",
  "ClassDeclaration", "InterfaceDeclaration", "TraitDeclaration", "EnumDeclaration",
]);

// ---------------------------------------------------------------------------
// Main AST traversal — collect class outlines
// ---------------------------------------------------------------------------

function collectClassOutlines(
  statementNodes: unknown[],
  lineIndex: number[],
  currentNamespace: string | null = null
): ClassOutline[] {
  const results: ClassOutline[] = [];

  for (const stmt of statementNodes) {
    const kind = nodeType(stmt);
    if (!kind) continue;

    if (kind === "Namespace" || kind === "NamespaceDeclaration" || kind === "NamespaceStatement") {
      const nsValue = nodeValue(stmt);
      if (!nsValue) continue;
      const nsName = extractMagoFqn(nsValue.name) ?? currentNamespace;
      const bodyVal = nodeValue(nsValue.body);
      if (!bodyVal) continue;
      const bodyStatements = nodesOf(bodyVal.statements);
      results.push(...collectClassOutlines(bodyStatements, lineIndex, nsName));
      continue;
    }

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

      let implementsList: string[] = [];
      if (classValue.implements && typeof classValue.implements === "object") {
        const implementsObj = classValue.implements as Record<string, unknown>;
        implementsList = extractImplementsList(implementsObj.types);
      }

      const methods = extractMagoMethods(classValue.members, lineIndex);

      results.push({
        class: className,
        namespace: currentNamespace,
        extends: extendsName,
        implements: implementsList,
        methods,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool: get_class_outline
// ---------------------------------------------------------------------------

function getClassOutline(filePath: string): ClassOutline[] {
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

  const prog = (ast as Record<string, unknown>).program as Record<string, unknown> | undefined;
  if (!prog) throw new Error("Unexpected mago AST shape: missing 'program' key.");

  const topNodes = nodesOf(prog.statements);
  return collectClassOutlines(topNodes, lineIndex);
}

// ---------------------------------------------------------------------------
// Tool: get_method
// ---------------------------------------------------------------------------

function getMethod(filePath: string, methodName: string): string {
  const classes = getClassOutline(filePath);

  for (const cls of classes) {
    const method = cls.methods.find((m) => m.name === methodName);
    if (method) {
      return readLines(filePath, method.start_line, method.end_line);
    }
  }

  throw new Error(`Method '${methodName}' not found in ${filePath}`);
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
      name: "get_class_outline",
      description:
        "Returns only method names and line ranges for a PHP class. " +
        "No signatures, no types, no bodies. Use this first to orient, " +
        "then call get_method or read_lines for the actual code.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the PHP file" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "get_method",
      description:
        "Reads the full source code of a single PHP method by name. " +
        "Call get_class_outline first if you don't know the method name. " +
        "Prefer this over read_lines for reading PHP methods.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the PHP file" },
          method_name: { type: "string", description: "Name of the method to read" },
        },
        required: ["file_path", "method_name"],
      },
    },
    {
      name: "read_lines",
      description:
        "Read a specific line range from any file. Use for code outside a named method " +
        "(e.g. top-level statements, anonymous classes, or arbitrary line ranges).",
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
        "Use this to inspect the AST structure when get_class_outline returns unexpected results.",
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

const GetClassOutlineInput = z.object({ file_path: z.string() });
const GetMethodInput = z.object({ file_path: z.string(), method_name: z.string() });
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
      case "get_class_outline": {
        const { file_path } = GetClassOutlineInput.parse(args);
        const classes = getClassOutline(file_path);
        return { content: [{ type: "text", text: JSON.stringify(classes) }] };
      }

      case "get_method": {
        const { file_path, method_name } = GetMethodInput.parse(args);
        const source = getMethod(file_path, method_name);
        return { content: [{ type: "text", text: source }] };
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
