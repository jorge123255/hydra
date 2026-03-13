// Discord channel adapter.
// Wraps discord.js Client and normalizes events to Hydra's InboundMessage format.

import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
  type ThreadChannel,
  Partials,
} from "discord.js";
import { BaseChannel } from "@hydra/core";
import type { InboundMessage, OutboundMessage } from "@hydra/core";

export type DiscordChannelConfig = {
  token: string;
  // Discord role name that grants bot access (from Kimaki: "Kimaki" role)
  accessRoleName?: string;
  // Discord role name that blocks access
  denyRoleName?: string;
};

export class DiscordChannel extends BaseChannel {
  readonly id = "discord" as const;
  readonly name = "Discord";

  private client: Client;
  private config: DiscordChannelConfig;

  constructor(config: DiscordChannelConfig) {
    super();
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start(): Promise<void> {
    this.client.on("ready", () => {
      this.emitEvent({ type: "connected", channelId: this.id });
    });

    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot) return;
      if (!this.hasAccess(msg)) return;

      const inbound = this.normalizeMessage(msg);
      await this.emitMessage(inbound);
    });

    this.client.on("error", (error: Error) => {
      this.emitEvent({ type: "error", channelId: this.id, error });
    });

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
    this.emitEvent({ type: "disconnected", channelId: this.id });
  }

  async send(message: OutboundMessage): Promise<void> {
    const channel = await this.client.channels.fetch(message.threadId);
    if (!channel || (!channel.isTextBased())) {
      throw new Error(`Discord channel ${message.threadId} not found or not text-based`);
    }
    const textChannel = channel as TextChannel | ThreadChannel;
    // Discord has a 2000 char limit — split if needed
    const chunks = this.splitMessage(message.text);
    for (const chunk of chunks) {
      await textChannel.send(chunk);
    }
  }

  async sendTyping(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId);
    if (channel?.isTextBased()) {
      await (channel as TextChannel).sendTyping();
    }
  }

  private hasAccess(msg: Message): boolean {
    if (!msg.guild) return true; // DMs always allowed
    const member = msg.guild.members.cache.get(msg.author.id);
    if (!member) return false;

    const denyRole = this.config.denyRoleName;
    if (denyRole && member.roles.cache.some((r) => r.name === denyRole)) return false;

    const accessRole = this.config.accessRoleName;
    if (accessRole) {
      return member.roles.cache.some((r) => r.name === accessRole);
    }
    return true;
  }

  private normalizeMessage(msg: Message): InboundMessage {
    return {
      id: msg.id,
      channelId: this.id,
      threadId: msg.channelId,
      senderId: msg.author.id,
      senderName: msg.author.username,
      text: msg.content,
      replyToId: msg.reference?.messageId,
      timestamp: msg.createdAt,
      raw: msg,
      attachments: msg.attachments.map((a) => ({
        type: "file" as const,
        url: a.url,
        mimeType: a.contentType ?? undefined,
        name: a.name,
      })),
    };
  }

  private splitMessage(text: string, limit = 1990): string[] {
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
