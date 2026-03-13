// Telegram channel adapter for Hydra.
// Uses grammy (same as OpenClaw's src/telegram/) with OpenClaw's proven patterns:
// - apiThrottler to avoid Telegram rate limits
// - sequentialize to prevent concurrent message handling per chat
// - Auto-select IPv4/IPv6 family (WSL2 fix from OpenClaw)

import { Bot } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { sequentialize } from "@grammyjs/runner";
import { BaseChannel } from "@hydra/core";
import type { InboundMessage, OutboundMessage } from "@hydra/core";

export type TelegramChannelConfig = {
  token: string;
  // Restrict to specific user IDs or usernames (from OpenClaw's allowFrom)
  allowFrom?: Array<string | number>;
  // Max file size in MB
  mediaMaxMb?: number;
  // Webhook URL (if not set, uses long polling)
  webhookUrl?: string;
};

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export class TelegramChannel extends BaseChannel {
  readonly id = "telegram" as const;
  readonly name = "Telegram";

  private bot: Bot;
  private config: TelegramChannelConfig;

  constructor(config: TelegramChannelConfig) {
    super();
    this.config = config;
    this.bot = new Bot(config.token);

    // Apply OpenClaw's proven middleware stack
    this.bot.api.config.use(apiThrottler());
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Sequentialize per chat_id — prevents concurrent handling of messages
    // from the same chat, mirroring OpenClaw's sequential-key approach
    this.bot.use(
      sequentialize((ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? "unknown"))
    );

    this.bot.on("message", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id, ctx.from?.username)) return;

      const text = ctx.message.text ?? ctx.message.caption ?? "";
      if (!text && !ctx.message.photo && !ctx.message.document && !ctx.message.audio) return;

      const inbound: InboundMessage = {
        id: String(ctx.message.message_id),
        channelId: this.id,
        threadId: String(ctx.chat.id),
        senderId: String(ctx.from?.id ?? "unknown"),
        senderName: ctx.from?.username ?? ctx.from?.first_name,
        text,
        replyToId: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
        timestamp: new Date(ctx.message.date * 1000),
        raw: ctx.message,
        attachments: this.extractAttachments(ctx.message),
      };

      await this.emitMessage(inbound);
    });

    this.bot.catch((err) => {
      this.emitEvent({
        type: "error",
        channelId: this.id,
        error: err.error instanceof Error ? err.error : new Error(String(err)),
      });
    });
  }

  async start(): Promise<void> {
    if (this.config.webhookUrl) {
      await this.bot.api.setWebhook(this.config.webhookUrl);
    } else {
      // Long polling — delete any existing webhook first
      await this.bot.api.deleteWebhook();
      this.bot.start({
        onStart: () => this.emitEvent({ type: "connected", channelId: this.id }),
      });
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.emitEvent({ type: "disconnected", channelId: this.id });
  }

  async send(message: OutboundMessage): Promise<void> {
    const chatId = Number(message.threadId);
    const chunks = this.splitMessage(message.text);

    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk, {
        parse_mode: "Markdown",
        reply_parameters: message.replyToId
          ? { message_id: Number(message.replyToId) }
          : undefined,
      });
    }
  }

  async sendTyping(threadId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(threadId), "typing");
  }

  private isAllowed(userId?: number, username?: string): boolean {
    const { allowFrom } = this.config;
    if (!allowFrom || allowFrom.length === 0) return true;
    return allowFrom.some(
      (a) =>
        (typeof a === "number" && a === userId) ||
        (typeof a === "string" && a === username)
    );
  }

  private extractAttachments(message: any): InboundMessage["attachments"] {
    const attachments: NonNullable<InboundMessage["attachments"]> = [];

    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1];
      attachments.push({ type: "image", url: largest.file_id, mimeType: "image/jpeg" });
    }
    if (message.document) {
      attachments.push({
        type: "file",
        url: message.document.file_id,
        mimeType: message.document.mime_type,
        name: message.document.file_name,
      });
    }
    if (message.audio) {
      attachments.push({ type: "audio", url: message.audio.file_id, mimeType: "audio/mpeg" });
    }
    if (message.voice) {
      attachments.push({ type: "audio", url: message.voice.file_id, mimeType: "audio/ogg" });
    }

    return attachments;
  }

  private splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      // Try to split on newline to avoid breaking mid-sentence
      let cutAt = limit;
      const newline = remaining.lastIndexOf("\n", limit);
      if (newline > limit * 0.5) cutAt = newline + 1;
      chunks.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt);
    }
    return chunks;
  }
}
