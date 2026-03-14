#!/bin/bash
# Install Hydra gateway as a launchd user daemon on macOS (bob).
# Usage: bash scripts/install-daemon.sh
set -e

HYDRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_LABEL="ai.hydra.gateway"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/.hydra/logs"
TSX_BIN="$(which tsx 2>/dev/null || echo "$HYDRA_DIR/node_modules/.bin/tsx")"

mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

# Collect env vars from .env file
ENV_ENTRIES=""
if [ -f "$HYDRA_DIR/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    KEY="${line%%=*}"
    VAL="${line#*=}"
    VAL="${VAL%\"}"
    VAL="${VAL#\"}"
    VAL="${VAL%\'}"
    VAL="${VAL#\'}"
    ENV_ENTRIES+="    <key>$KEY</key><string>$VAL</string>\n"
  done < "$HYDRA_DIR/.env"
fi

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${TSX_BIN}</string>
    <string>${HYDRA_DIR}/packages/gateway/src/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${HYDRA_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
$(printf "$ENV_ENTRIES")  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/gateway.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/gateway.err</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "✅ Hydra daemon installed and started"
echo "   Logs:   $LOG_DIR/gateway.log"
echo "   Errors: $LOG_DIR/gateway.err"
echo "   Status: bash scripts/daemon-status.sh"
