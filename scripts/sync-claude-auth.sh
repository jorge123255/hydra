#!/bin/bash
# Sync Claude Code OAuth credentials to Hydra's credentials directory.
# Run this from Terminal (not SSH) so macOS can grant keychain access.
# Re-run whenever Claude Code refreshes your token (if the bot says "expired").

set -e
CRED_DIR="$HOME/.hydra/credentials"
mkdir -p "$CRED_DIR"

# Try keychain first
echo "Reading Claude Code credentials from keychain..."
RAW=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)

# Fallback to credentials file
if [ -z "$RAW" ]; then
  echo "Keychain empty, trying ~/.claude/.credentials.json..."
  RAW=$(cat "$HOME/.claude/.credentials.json" 2>/dev/null || true)
fi

if [ -z "$RAW" ]; then
  echo "❌ No Claude credentials found."
  echo "   Make sure you're logged into Claude Code: run 'claude' in Terminal."
  exit 1
fi

# Validate it has an accessToken
ACCESS=$(echo "$RAW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('claudeAiOauth',{}).get('accessToken',''))" 2>/dev/null || true)

if [ -z "$ACCESS" ]; then
  echo "❌ Credentials found but no accessToken — try logging in again with 'claude'."
  exit 1
fi

# Write to Hydra credentials dir
echo "$RAW" > "$CRED_DIR/claude-code-oauth.json"
echo "✅ Claude credentials synced to $CRED_DIR/claude-code-oauth.json"

EXPIRES=$(echo "$RAW" | python3 -c "
import sys,json,datetime
d=json.load(sys.stdin)
exp=d.get('claudeAiOauth',{}).get('expiresAt',0)
if exp > 1e10: exp = exp/1000
print(datetime.datetime.fromtimestamp(exp).strftime('%Y-%m-%d %H:%M'))
" 2>/dev/null || echo "unknown")

echo "   Token expires: $EXPIRES"
echo ""
echo "The Hydra bot will now use this token automatically."
echo "Run this script again if the bot says the token is expired."
