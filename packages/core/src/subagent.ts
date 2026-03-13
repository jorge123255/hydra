// Subagent system — ported from OpenClaw's src/agents/ subagent architecture.
// Supports spawning, depth limits, registry, and result announcement.

import type { InboundMessage } from "./types.js";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type SubagentConfig = {
  id: string;
  parentId?: string;
  // The task/prompt to give the subagent
  prompt: string;
  // Working directory for coding tasks
  workdir?: string;
  // Max depth to prevent runaway nesting (from OpenClaw's subagent-depth.ts)
  maxDepth?: number;
  currentDepth?: number;
  timeoutMs?: number;
  // The originating message that spawned this subagent
  sourceMessage?: InboundMessage;
};

export type SubagentResult = {
  id: string;
  status: SubagentStatus;
  output?: string;
  error?: string;
  durationMs?: number;
};

export type SubagentAnnouncement = {
  subagentId: string;
  parentId?: string;
  result: SubagentResult;
  // Thread/channel to announce completion back to
  announceThreadId?: string;
  announceChannelId?: string;
};

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Subagent registry — tracks all active subagents (from OpenClaw's subagent-registry.ts)
export class SubagentRegistry {
  private agents = new Map<string, SubagentConfig & { status: SubagentStatus }>();

  spawn(config: SubagentConfig): void {
    const depth = config.currentDepth ?? 0;
    const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;

    if (depth >= maxDepth) {
      throw new Error(
        `Subagent depth limit reached (${depth}/${maxDepth}). Cannot spawn further subagents.`
      );
    }

    this.agents.set(config.id, { ...config, status: "pending" });
  }

  updateStatus(id: string, status: SubagentStatus): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = status;
    }
  }

  get(id: string) {
    return this.agents.get(id);
  }

  getActive() {
    return Array.from(this.agents.values()).filter(
      (a) => a.status === "pending" || a.status === "running"
    );
  }

  cleanup(id: string): void {
    this.agents.delete(id);
  }

  // Get all children of a parent subagent
  getChildren(parentId: string) {
    return Array.from(this.agents.values()).filter((a) => a.parentId === parentId);
  }
}
