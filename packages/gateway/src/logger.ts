// Simple logger with prefixes — keeps output readable across channels
const levels = ["debug", "info", "warn", "error"] as const;
type Level = (typeof levels)[number];

const LEVEL_COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info:  "\x1b[36m",
  warn:  "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

export function createLogger(prefix: string) {
  const log = (level: Level, ...args: unknown[]) => {
    const ts = new Date().toISOString().slice(11, 23);
    const color = LEVEL_COLORS[level];
    console.log(`${color}[${ts}] [${level.toUpperCase()}] [${prefix}]${RESET}`, ...args);
  };
  return {
    debug: (...args: unknown[]) => log("debug", ...args),
    info:  (...args: unknown[]) => log("info", ...args),
    warn:  (...args: unknown[]) => log("warn", ...args),
    error: (...args: unknown[]) => log("error", ...args),
  };
}
