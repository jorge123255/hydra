// The Channel interface every adapter must implement.
// Inspired by OpenClaw's channel plugin architecture.

import type { ChannelId, InboundMessage, OutboundMessage, ChannelEvent } from "./types.js";

export type MessageHandler = (message: InboundMessage) => Promise<void>;
export type EventHandler = (event: ChannelEvent) => void;

export interface Channel {
  readonly id: ChannelId;
  readonly name: string;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Sending
  send(message: OutboundMessage): Promise<void>;
  // Indicate typing/processing to the user
  sendTyping(threadId: string): Promise<void>;

  // Event subscription
  onMessage(handler: MessageHandler): void;
  onEvent(handler: EventHandler): void;
}

// Base class providing common handler management
export abstract class BaseChannel implements Channel {
  abstract readonly id: ChannelId;
  abstract readonly name: string;

  protected messageHandlers: MessageHandler[] = [];
  protected eventHandlers: EventHandler[] = [];

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(message: OutboundMessage): Promise<void>;
  abstract sendTyping(threadId: string): Promise<void>;

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  protected async emitMessage(message: InboundMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler(message);
    }
  }

  protected emitEvent(event: ChannelEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }
}
