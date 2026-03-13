// Channel registry — tracks all registered adapters.
// Modeled after OpenClaw's channel registry with plugin docking.

import type { Channel, MessageHandler, EventHandler } from "./channel.js";
import type { ChannelId, OutboundMessage } from "./types.js";

export class ChannelRegistry {
  private channels = new Map<ChannelId, Channel>();

  register(channel: Channel): void {
    if (this.channels.has(channel.id)) {
      throw new Error(`Channel '${channel.id}' is already registered`);
    }
    this.channels.set(channel.id, channel);
  }

  get(id: ChannelId): Channel | undefined {
    return this.channels.get(id);
  }

  getAll(): Channel[] {
    return Array.from(this.channels.values());
  }

  async startAll(): Promise<void> {
    await Promise.all(this.getAll().map((c) => c.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.getAll().map((c) => c.stop()));
  }

  // Broadcast a handler to all registered channels
  onMessage(handler: MessageHandler): void {
    for (const channel of this.getAll()) {
      channel.onMessage(handler);
    }
  }

  onEvent(handler: EventHandler): void {
    for (const channel of this.getAll()) {
      channel.onEvent(handler);
    }
  }

  async send(channelId: ChannelId, message: OutboundMessage): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      throw new Error(`No channel registered for '${channelId}'`);
    }
    await channel.send(message);
  }
}
