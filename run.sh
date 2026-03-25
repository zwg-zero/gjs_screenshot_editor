#!/bin/bash
# Launch the Screenshot Editor
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec gjs -m "$SCRIPT_DIR/screenshot-editor.js" "$@"
