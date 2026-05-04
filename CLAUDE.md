# PHP Structure MCP Server

## PHP File Reading

- To explore a PHP class: call `get_class_outline` first — returns method names and line ranges only
- To read a method: call `get_method` with file path and method name
- Never use the Read tool on a full PHP file
- Use `read_lines` only for code outside a named method
