# php-structure-mcp

MCP server that exposes PHP class structure to Claude Code via [Mago](https://github.com/carthage-software/mago)'s AST, so Claude reads only the relevant lines instead of entire files.

## Tools

| Tool | Purpose |
|------|----------|
| `get_class_structure` | Parse a PHP file and return all classes/interfaces/traits with per-method line numbers |
| `read_lines` | Read a specific line range from any file |
| `find_class_file` | Resolve a fully-qualified class name to an absolute path via Composer autoload maps |
| `debug_ast` | Dump the raw mago AST JSON (first 4 KB) — useful when `get_class_structure` returns unexpected results |

## Requirements

- [Mago](https://github.com/carthage-software/mago) installed and accessible
- Node.js 18+

## Installation

```bash
npm install
npm run build
```

## Configuration

### Claude Code (`~/.claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "php-structure": {
      "command": "node",
      "args": ["/absolute/path/to/php-structure-mcp/dist/index.js"],
      "env": {
        "MAGO_PATH": "/absolute/path/to/mago"
      }
    }
  }
}
```

Set `MAGO_PATH` to the absolute path of the `mago` binary if it is not on `PATH` when Claude Code spawns the server.

### Project `CLAUDE.md`

Add this to any PHP project's `CLAUDE.md` so Claude picks up the tools automatically:

```markdown
## PHP File Reading
Before reading any PHP file, call `get_class_structure` first.
Use `read_lines` with a specific range, never read a full PHP file.
To find a class file, use `find_class_file` instead of searching manually.
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAGO_PATH` | `mago` | Absolute path to the mago binary |

## Development

```bash
npm run dev        # run with tsx (no build step)
npm run build      # compile to dist/
npm start          # run compiled output
```

## Troubleshooting

If `get_class_structure` returns empty results or wrong line numbers, use `debug_ast` to inspect the raw JSON that mago produces for your file. The AST traversal code handles both external-tagged (`{"ClassDeclaration": {...}}`) and internal-tagged (`{"type": "ClassDeclaration", ...}`) serde formats, but new mago versions may introduce structural changes.
