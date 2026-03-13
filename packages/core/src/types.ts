// Core types shared across all channel adapters.
// Modeled after OpenClaw's channel abstraction layer.

export type ChannelId =
  | "discord"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "signal"
  | "imessage"
  | "googlechat"
  | "irc"
  | "line";

// A normalized inbound message from any channel
export type InboundMessage = {
  id: string;
  channelId: ChannelId;
  // The platform-specific thread/conversation/room id
  threadId: string;
  // The sender's identifier on that platform
  senderId: string;
  senderName?: string;
  text: string;
  attachments?: Attachment[];
  replyToId?: string;
  timestamp: Date;
  // Raw platform-specific payload for adapters that need it
  raw?: unknown;
};

export type Attachment = {
  type: "image" | "audio" | "video" | "file";
  url?: string;
  data?: Buffer;
  mimeType?: string;
  name?: string;
};

// A normalized outbound message to any channel
export type OutboundMessage = {
  threadId: string;
  text: string;
  replyToId?: string;
  attachments?: Attachment[];
};

// Lifecycle events a channel adapter can emit
export type ChannelEvent =
  | { type: "message"; message: InboundMessage }
  | { type: "connected"; channelId: ChannelId }
  | { type: "disconnected"; channelId: ChannelId; reason?: string }
  | { type: "error"; channelId: ChannelId; error: Error };
