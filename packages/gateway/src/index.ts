// Hydra Gateway entry point.
// Configure your channels via environment variables and start.

import { ChannelRegistry } from "@hydra/core";
import { DiscordChannel } from "@hydra/discord";
import { TelegramChannel } from "@hydra/telegram";
import { Gateway } from "./gateway.js";
import { createLogger } from "./logger.js";

const log = createLogger("main");

async function main() {
  const registry = new ChannelRegistry();

  // Register Discord if token is provided
  if (process.env.DISCORD_TOKEN) {
    registry.register(
      new DiscordChannel({
        token: process.env.DISCORD_TOKEN,
        accessRoleName: process.env.DISCORD_ACCESS_ROLE ?? "Hydra",
        denyRoleName: process.env.DISCORD_DENY_ROLE ?? "no-hydra",
      })
    );
    log.info("Discord channel registered");
  }

  // Register Telegram if token is provided
  if (process.env.TELEGRAM_BOT_TOKEN) {
    registry.register(
      new TelegramChannel({
        token: process.env.TELEGRAM_BOT_TOKEN,
        allowFrom: process.env.TELEGRAM_ALLOW_FROM
          ? process.env.TELEGRAM_ALLOW_FROM.split(",").map((v) => {
              const n = Number(v.trim());
              return isNaN(n) ? v.trim() : n;
            })
          : undefined,
      })
    );
    log.info("Telegram channel registered");
  }

  if (registry.getAll().length === 0) {
    log.error("No channels configured. Set DISCORD_TOKEN or TELEGRAM_BOT_TOKEN.");
    process.exit(1);
  }

  const gateway = new Gateway(registry, {
    workdir: process.env.HYDRA_WORKDIR ?? process.cwd(),
    sessionIdleMs: 30 * 60 * 1000,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await gateway.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
