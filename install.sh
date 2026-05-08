#!/usr/bin/env bash
# Registers php-ast-mcp as a Claude Code plugin (user scope).
# Safe to re-run — overwrites the existing entry.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALLED_PLUGINS="$HOME/.claude/plugins/installed_plugins.json"

if [[ ! -f "$INSTALLED_PLUGINS" ]]; then
  echo "Error: $INSTALLED_PLUGINS not found. Is Claude Code installed?" >&2
  exit 1
fi

python3 - "$INSTALLED_PLUGINS" "$PLUGIN_DIR" << 'EOF'
import sys, json
from datetime import datetime, timezone

plugins_file, plugin_dir = sys.argv[1], sys.argv[2]

with open(plugins_file) as f:
    data = json.load(f)

now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
data.setdefault("plugins", {})["php-ast-mcp@local"] = [{
    "scope": "user",
    "installPath": plugin_dir,
    "version": "local",
    "installedAt": now,
    "lastUpdated": now,
}]

with open(plugins_file, "w") as f:
    json.dump(data, f, indent=4)
EOF

echo "Installed php-ast-mcp plugin from $PLUGIN_DIR"
echo "Restart Claude Code to activate."
