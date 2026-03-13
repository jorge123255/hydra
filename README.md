# Hydra

**The reliability of Kimaki + the multi-channel power of OpenClaw.**

Hydra is a self-hosted AI coding agent gateway that connects OpenCode to multiple messaging platforms simultaneously. Send coding tasks from Discord, Telegram, Slack, WhatsApp — wherever your team lives.

## Architecture

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Discord   │  │   Telegram  │  │   Slack...  │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
              ┌─────────▼──────────┐
              │   @hydra/gateway   │  ← Channel registry, session manager, subagent orchestrator
              └─────────┬──────────┘
                        │
              ┌─────────▼──────────┐
              │  OpenCode Server   │  ← One shared process, sessions scoped per thread
              └────────────────────┘
```

### Packages

| Package | Description |
|---|---|
| `@hydra/core` | Channel interface, registry, types, subagent system |
| `@hydra/discord` | Discord adapter (based on Kimaki) |
| `@hydra/telegram` | Telegram adapter (based on OpenClaw) |
| `@hydra/gateway` | Main orchestrator — wires channels to OpenCode |

## Quickstart

```bash
# Install dependencies
pnpm install

# Copy and fill in your tokens
cp .env.example .env

# Run
pnpm dev
```

## Credits

- **[Kimaki](https://github.com/remorses/kimaki)** — stable Discord + OpenCode integration
- **[OpenClaw](https://github.com/openclaw/openclaw)** — multi-channel architecture and subagent system
