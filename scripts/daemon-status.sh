#!/bin/bash
echo "=== launchctl status ==="
launchctl list | grep hydra || echo "(not loaded)"
echo ""
echo "=== Recent log (last 50 lines) ==="
tail -50 "$HOME/.hydra/logs/gateway.log" 2>/dev/null || echo "(no log yet)"
echo ""
echo "=== Recent errors ==="
tail -20 "$HOME/.hydra/logs/gateway.err" 2>/dev/null || echo "(no errors)"
