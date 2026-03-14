#!/bin/bash
PLIST_PATH="$HOME/Library/LaunchAgents/ai.hydra.gateway.plist"
launchctl unload "$PLIST_PATH" 2>/dev/null && echo "✅ Hydra daemon stopped" || echo "⚠️  Daemon was not loaded"
rm -f "$PLIST_PATH" && echo "✅ Plist removed"
