import {
  Client, GatewayIntentBits, type Message,
  type TextChannel, type ThreadChannel, Partials,
} from "discord.js";
import { BaseChannel } from "@hydra/core";
import type { InboundMessage, OutboundMessage } from "@hydra/core";
import https from "node:https";

export type DiscordChannelConfig = {
  token: string;
  accessRoleName?: string;
  denyRoleName?: string;
};

const DISCORD_MAX = 1990;
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export class DiscordChannel extends BaseChannel {
  readonly id = "discord" as const;
  readonly name = "Discord";
  private client: Client;
  private config: DiscordChannelConfig;
  // Map messageId -> discord Message object for editing
  private sentMessages = new Map<string, Message>();

  constructor(config: DiscordChannelConfig) {
    super();
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start(): Promise<void> {
    this.client.on("ready", () => this.emitEvent({ type: "connected", channelId: this.id }));
    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot) return;
      if (!this.hasAccess(msg)) return;
      const images = await this.downloadImages(msg);
      const inbound = this.normalizeMessage(msg, images);
      await this.emitMessage(inbound);
    });
    this.client.on("error", (error: Error) =>
      this.emitEvent({ type: "error", channelId: this.id, error })
    );
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
    this.emitEvent({ type: "disconnected", channelId: this.id });
  }

  async send(message: OutboundMessage): Promise<void> {
    await this.sendAndGetId(message);
  }

  async sendAndGetId(message: OutboundMessage): Promise<string> {
    if (message.editMessageId) {
      await this.editMessage(message.threadId, message.editMessageId, message.text);
      return message.editMessageId;
    }
    const channel = await this.client.channels.fetch(message.threadId);
    if (!channel?.isTextBased()) throw new Error(`Discord channel ${message.threadId} not found`);
    const tc = channel as TextChannel | ThreadChannel;
    const chunks = this.splitMessage(message.text);
    let lastId = "";
    for (const chunk of chunks) {
      const sent = await tc.send(chunk);
      this.sentMessages.set(sent.id, sent);
      lastId = sent.id;
    }
    return lastId;
  }

  async editMessage(_threadId: string, messageId: string, text: string): Promise<void> {
    const msg = this.sentMessages.get(messageId);
    if (!msg) return;
    const truncated = text.length > DISCORD_MAX ? text.slice(0, DISCORD_MAX - 3) + "..." : text;
    await msg.edit(truncated).catch(() => {});
  }

  async sendTyping(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (channel?.isTextBased()) await (channel as TextChannel).sendTyping();
  }

  private hasAccess(msg: Message): boolean {
    if (!msg.guild) return true;
    const member = msg.guild.members.cache.get(msg.author.id);
    if (!member) return false;
    if (this.config.denyRoleName && member.roles.cache.some((r) => r.name === this.config.denyRoleName)) return false;
    if (this.config.accessRoleName) return member.roles.cache.some((r) => r.name === this.config.accessRoleName);
    return true;
  }

  private async downloadImages(msg: Message): Promise<string[]> {
    const images: string[] = [];
    for (const att of msg.attachments.values()) {
      const ct = att.contentType ?? "";
      if (!ct.startsWith("image/")) continue;
      const b64 = await this.downloadUrl(att.url);
      if (b64) images.push(`data:${ct};base64,${b64}`);
    }
    return images;
  }

  private downloadUrl(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      https.get(url, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MEDIA_MAX_BYTES) { resolve(null); res.destroy(); return; }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
        res.on("error", () => resolve(null));
      }).on("error", () => resolve(null));
    });
  }

  private normalizeMessage(msg: Message, images: string[]): InboundMessage {
    return {
      id: msg.id, channelId: this.id, threadId: msg.channelId,
      senderId: msg.author.id, senderName: msg.author.username,
      text: msg.content,
      images: images.length ? images : undefined,
      replyToId: msg.reference?.messageId,
      timestamp: msg.createdAt, raw: msg,
      attachments: msg.attachments.map((a) => ({
        type: "file" as const, url: a.url,
        mimeType: a.contentType ?? undefined, name: a.name,
      })),
    };
  }

  private splitMessage(text: string, limit = DISCORD_MAX): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    return chunks;
  }
}
