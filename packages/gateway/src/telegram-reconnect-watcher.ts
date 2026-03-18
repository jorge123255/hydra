// Telegram reconnection watcher — auto-reconnects when Telegram disconnects
// Requires: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_BOT_TOKEN

import { ChannelRegistry, type ChannelEvent } from "@hydra/core";
import { createLogger } from "./logger.js";

const logger = createLogger("telegram-reconnect-watcher");

export class TelegramReconnectWatcher {
  private reconnectInterval: NodeJS.Timeout | null = null;
  private isReconnecting = false;

  constructor(private channelRegistry: ChannelRegistry) {
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.channelRegistry.onEvent((event: ChannelEvent) => {
      if (event.type === 'message') return;
      if (event.channelId !== 'telegram') return;
      if (event.type === "disconnected") {
        logger.warn("Telegram disconnected — scheduling auto-reconnect");
        this.scheduleReconnect();
      } else if (event.type === "connected") {
        logger.info("Telegram reconnected successfully");
        this.cancelReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    // Immediate first attempt
    this.attemptReconnect();

    // Then exponential backoff: 5s, 10s, 20s, 40s, 80s, 160s, 320s, 640s
    let delay = 5000;
    this.reconnectInterval = setInterval(() => {
      this.attemptReconnect();
      delay = Math.min(delay * 2, 640000); // Cap at 10 minutes
    }, delay);
  }

  private attemptReconnect() {
    try {
      const telegramChannel = this.channelRegistry.get("telegram") as any;
      if (telegramChannel?.reconnect) {
        telegramChannel.reconnect();
      } else if (telegramChannel?.start) {
        telegramChannel.start();
      }
    } catch (error) {
      logger.error(`Reconnect attempt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cancelReconnect() {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    this.isReconnecting = false;
  }

  public destroy() {
    this.cancelReconnect();
  }
}
