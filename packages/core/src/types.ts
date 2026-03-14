export type ChannelId =
  | "discord" | "telegram" | "slack"
  | "whatsapp" | "signal" | "imessage"
  | "googlechat" | "irc" | "line";

export type InboundMessage = {
  id: string;
  channelId: ChannelId;
  threadId: string;
  senderId: string;
  senderName?: string;
  text: string;
  attachments?: Attachment[];
  // base64 data URLs for images (e.g. "data:image/jpeg;base64,...")
  images?: string[];
  // raw base64 audio for voice messages (transcribed by gateway)
  voiceBase64?: string;
  voiceMimeType?: string;
  replyToId?: string;
  timestamp: Date;
  raw?: unknown;
  // Set a reaction emoji on the original message (feature 5)
  setReaction?: (emoji: string) => Promise<void>;
};

export type Attachment = {
  type: "image" | "audio" | "video" | "file";
  url?: string;
  data?: Buffer;
  mimeType?: string;
  name?: string;
};

export type OutboundMessage = {
  threadId: string;
  text: string;
  replyToId?: string;
  attachments?: Attachment[];
  // If set, edit this existing message instead of sending new
  editMessageId?: string;
};

export type ChannelEvent =
  | { type: "message"; message: InboundMessage }
  | { type: "connected"; channelId: ChannelId }
  | { type: "disconnected"; channelId: ChannelId; reason?: string }
  | { type: "error"; channelId: ChannelId; error: Error };
