import { Bot } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { sequentialize } from "@grammyjs/runner";
import { BaseChannel } from "@hydra/core";
import type { InboundMessage, OutboundMessage } from "@hydra/core";
import https from "node:https";

export type TelegramChannelConfig = {
  token: string;
  allowFrom?: Array<string | number>;
  mediaMaxMb?: number;
  webhookUrl?: string;
};

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const MEDIA_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export class TelegramChannel extends BaseChannel {
  readonly id = "telegram" as const;
  readonly name = "Telegram";
  private bot: Bot;
  private config: TelegramChannelConfig;

  constructor(config: TelegramChannelConfig) {
    super();
    this.config = config;
    this.bot = new Bot(config.token);
    this.bot.api.config.use(apiThrottler());
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.use(sequentialize((ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? "unknown")));

    this.bot.on("message", async (ctx) => {
      if (!this.isAllowed(ctx.from?.id, ctx.from?.username)) return;
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      if (!text && !ctx.message.photo && !ctx.message.document && !ctx.message.audio) return;

      // Download images for vision support
      const images: string[] = [];
      if (ctx.message.photo?.length) {
        const largest = ctx.message.photo[ctx.message.photo.length - 1];
        const b64 = await this.downloadFileAsBase64(largest.file_id, "image/jpeg");
        if (b64) images.push(`data:image/jpeg;base64,${b64}`);
      }
      if (ctx.message.document?.mime_type?.startsWith("image/")) {
        const b64 = await this.downloadFileAsBase64(
          ctx.message.document.file_id,
          ctx.message.document.mime_type
        );
        if (b64) images.push(`data:${ctx.message.document.mime_type};base64,${b64}`);
      }

      const chatId = ctx.chat.id;
      const msgId = ctx.message.message_id;

      const inbound: InboundMessage = {
        id: String(msgId),
        channelId: this.id,
        threadId: String(chatId),
        senderId: String(ctx.from?.id ?? "unknown"),
        senderName: ctx.from?.username ?? ctx.from?.first_name,
        text,
        images: images.length ? images : undefined,
        replyToId: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
        timestamp: new Date(ctx.message.date * 1000),
        raw: ctx.message,
        attachments: this.extractAttachments(ctx.message),
        // Feature 5: reaction callback
        setReaction: async (emoji: string) => {
          try {
            await (this.bot.api as any).setMessageReaction(chatId, msgId, [
              { type: "emoji", emoji },
            ]);
          } catch {
            // ignore — reaction may not be supported or emoji may be invalid
          }
        },
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
      await this.bot.api.deleteWebhook();
      this.bot.start({ onStart: () => this.emitEvent({ type: "connected", channelId: this.id }) });
    }
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.emitEvent({ type: "disconnected", channelId: this.id });
  }

  async send(message: OutboundMessage): Promise<void> {
    await this.sendAndGetId(message);
  }

  async sendAndGetId(message: OutboundMessage): Promise<string> {
    const chatId = Number(message.threadId);
    if (message.editMessageId) {
      await this.editMessage(message.threadId, message.editMessageId, message.text);
      return message.editMessageId;
    }
    const chunks = this.splitMessage(message.text);
    let lastId = "";
    for (const chunk of chunks) {
      const sent = await this.bot.api.sendMessage(chatId, chunk, {
        reply_parameters: message.replyToId
          ? { message_id: Number(message.replyToId) }
          : undefined,
      });
      lastId = String(sent.message_id);
    }
    return lastId;
  }

  async editMessage(threadId: string, messageId: string, text: string): Promise<void> {
    const chatId = Number(threadId);
    const msgId = Number(messageId);
    if (!chatId || !msgId) return;
    const truncated = text.length > TELEGRAM_MAX_MESSAGE_LENGTH
      ? text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 3) + "..."
      : text;
    await this.bot.api.editMessageText(chatId, msgId, truncated).catch(() => {});
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const chatId = Number(threadId);
    const msgId = Number(messageId);
    if (!chatId || !msgId) return;
    await this.bot.api.deleteMessage(chatId, msgId).catch(() => {});
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

  private async downloadFileAsBase64(fileId: string, mime: string): Promise<string | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;
      const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
      return await new Promise<string | null>((resolve) => {
        https.get(url, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MEDIA_MAX_BYTES) { resolve(null); res.destroy(); return; }
            chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
          res.on("error", () => resolve(null));
        }).on("error", () => resolve(null));
      });
    } catch {
      return null;
    }
  }

  private extractAttachments(message: any): InboundMessage["attachments"] {
    const attachments: NonNullable<InboundMessage["attachments"]> = [];
    if (message.photo?.length) {
      const largest = message.photo[message.photo.length - 1];
      attachments.push({ type: "image", url: largest.file_id, mimeType: "image/jpeg" });
    }
    if (message.document) {
      attachments.push({ type: "file", url: message.document.file_id,
        mimeType: message.document.mime_type, name: message.document.file_name });
    }
    if (message.audio) attachments.push({ type: "audio", url: message.audio.file_id, mimeType: "audio/mpeg" });
    if (message.voice) attachments.push({ type: "audio", url: message.voice.file_id, mimeType: "audio/ogg" });
    return attachments;
  }

  private splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let cutAt = limit;
      const newline = remaining.lastIndexOf("\n", limit);
      if (newline > limit * 0.5) cutAt = newline + 1;
      chunks.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt);
    }
    return chunks;
  }
}
