// Session manager — bridges inbound messages to OpenCode sessions.
// Based on Kimaki's session-handler, generalized for any channel.
// One OpenCode server process, sessions scoped per thread+channel.

import { type InboundMessage, type ChannelRegistry, SubagentRegistry } from "@hydra/core";

export type SessionKey = string;

// Build a deterministic session key from channel + thread
export function buildSessionKey(channelId: string, threadId: string): SessionKey {
  return `${channelId}:${threadId}`;
}

export type ActiveSession = {
  key: SessionKey;
  channelId: string;
  threadId: string;
  workdir: string;
  startedAt: Date;
  lastActivityAt: Date;
};

export class SessionManager {
  private sessions = new Map<SessionKey, ActiveSession>();
  private subagentRegistry = new SubagentRegistry();
  private defaultWorkdir: string;

  constructor(opts: { defaultWorkdir: string }) {
    this.defaultWorkdir = opts.defaultWorkdir;
  }

  getOrCreate(message: InboundMessage): ActiveSession {
    const key = buildSessionKey(message.channelId, message.threadId);
    let session = this.sessions.get(key);

    if (!session) {
      session = {
        key,
        channelId: message.channelId,
        threadId: message.threadId,
        workdir: this.defaultWorkdir,
        startedAt: new Date(),
        lastActivityAt: new Date(),
      };
      this.sessions.set(key, session);
    } else {
      session.lastActivityAt = new Date();
    }

    return session;
  }

  get(key: SessionKey): ActiveSession | undefined {
    return this.sessions.get(key);
  }

  delete(key: SessionKey): void {
    this.sessions.delete(key);
  }

  get subagents(): SubagentRegistry {
    return this.subagentRegistry;
  }

  // Sweep sessions idle for longer than maxIdleMs
  sweepIdle(maxIdleMs: number): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > maxIdleMs) {
        this.sessions.delete(key);
      }
    }
  }
}
