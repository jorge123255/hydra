import type { ChannelId, InboundMessage, OutboundMessage, ChannelEvent } from "./types.js";

export type MessageHandler = (message: InboundMessage) => Promise<void>;
export type EventHandler = (event: ChannelEvent) => void;

export interface Channel {
  readonly id: ChannelId;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  // Send a message and return its platform message ID (for later editing)
  sendAndGetId(message: OutboundMessage): Promise<string>;
  // Edit an already-sent message in-place
  editMessage(threadId: string, messageId: string, text: string): Promise<void>;
  sendTyping(threadId: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onEvent(handler: EventHandler): void;
}

export abstract class BaseChannel implements Channel {
  abstract readonly id: ChannelId;
  abstract readonly name: string;
  protected messageHandlers: MessageHandler[] = [];
  protected eventHandlers: EventHandler[] = [];

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(message: OutboundMessage): Promise<void>;
  abstract sendTyping(threadId: string): Promise<void>;

  // Default: send and return empty string (channels override for real ID)
  async sendAndGetId(message: OutboundMessage): Promise<string> {
    await this.send(message);
    return "";
  }

  // Default: no-op (channels override to support live editing)
  async editMessage(_threadId: string, _messageId: string, _text: string): Promise<void> {}

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler); }
  onEvent(handler: EventHandler): void { this.eventHandlers.push(handler); }

  protected async emitMessage(message: InboundMessage): Promise<void> {
    for (const handler of this.messageHandlers) await handler(message);
  }
  protected emitEvent(event: ChannelEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }
}
