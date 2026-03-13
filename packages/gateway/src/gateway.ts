// The Hydra Gateway — the central orchestrator.
// Wires the ChannelRegistry to OpenCode sessions.
// This is where Kimaki's reliable OpenCode integration meets OpenClaw's multi-channel power.

import { ChannelRegistry, type InboundMessage, type ChannelEvent } from "@hydra/core";
import { SessionManager } from "./session-manager.js";
import { createLogger } from "./logger.js";

export type GatewayConfig = {
  // Default working directory for coding sessions
  workdir: string;
  // How long (ms) before an idle session is swept (default: 30min)
  sessionIdleMs?: number;
};

export class Gateway {
  private registry: ChannelRegistry;
  private sessions: SessionManager;
  private config: GatewayConfig;
  private log = createLogger("gateway");
  private sweepTimer?: NodeJS.Timeout;

  constructor(registry: ChannelRegistry, config: GatewayConfig) {
    this.registry = registry;
    this.config = config;
    this.sessions = new SessionManager({ defaultWorkdir: config.workdir });
  }

  async start(): Promise<void> {
    this.log.info("Starting Hydra gateway...");

    // Wire all channels to the message handler
    this.registry.onMessage(this.handleMessage.bind(this));
    this.registry.onEvent(this.handleEvent.bind(this));

    // Start all registered channel adapters
    await this.registry.startAll();

    // Sweep idle sessions every 5 minutes
    const idleMs = this.config.sessionIdleMs ?? 30 * 60 * 1000;
    this.sweepTimer = setInterval(() => this.sessions.sweepIdle(idleMs), 5 * 60 * 1000);

    this.log.info(`Gateway started with channels: ${this.registry.getAll().map((c) => c.id).join(", ")}`);
  }

  async stop(): Promise<void> {
    this.log.info("Stopping Hydra gateway...");
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.registry.stopAll();
    this.log.info("Gateway stopped.");
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    const session = this.sessions.getOrCreate(message);
    const channel = this.registry.get(message.channelId);
    if (!channel) return;

    this.log.debug(`[${message.channelId}] Message from ${message.senderName ?? message.senderId}: ${message.text.slice(0, 80)}`);

    try {
      // Signal typing while the agent processes
      await channel.sendTyping(message.threadId);

      // TODO: Route to OpenCode session using @opencode-ai/sdk
      // Pattern from Kimaki's session-handler/thread-session-runtime.ts:
      //   const client = getOpencodeClient(session.workdir)
      //   const stream = client.session.run({ prompt: message.text, sessionId: session.key })
      //   for await (const event of stream) { ... send partial replies ... }
      //
      // This is Phase 2 — for now log the session info
      this.log.info(`[${session.key}] Received: "${message.text.slice(0, 120)}"`);

    } catch (err) {
      this.log.error(`[${session.key}] Error handling message:`, err);
      await channel.send({
        threadId: message.threadId,
        text: "An error occurred while processing your message. Please try again.",
        replyToId: message.id,
      });
    }
  }

  private handleEvent(event: ChannelEvent): void {
    switch (event.type) {
      case "connected":
        this.log.info(`Channel connected: ${event.channelId}`);
        break;
      case "disconnected":
        this.log.info(`Channel disconnected: ${event.channelId} — ${event.reason ?? "no reason"}`);
        break;
      case "error":
        this.log.error(`Channel error [${event.channelId}]:`, event.error);
        break;
    }
  }
}
