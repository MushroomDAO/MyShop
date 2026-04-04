/**
 * W7: Structured JSON logger
 * Format: {"ts":1234567890,"level":"info","service":"permitServer","msg":"...","...extra}
 * Enable with LOG_FORMAT=json (default: plain text for dev)
 */

const JSON_MODE = process.env.LOG_FORMAT === "json";
const SERVICE = process.env.LOG_SERVICE || process.env.SERVICE_NAME || "worker";

function _safeStringify(obj) {
  try {
    return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v));
  } catch {
    return String(obj);
  }
}

function _write(level, msg, extra) {
  const ts = Math.floor(Date.now() / 1000);
  if (JSON_MODE) {
    const entry = { ts, level, service: SERVICE, msg };
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (k !== "ts" && k !== "level" && k !== "service" && k !== "msg") {
          entry[k] = typeof v === "bigint" ? v.toString() + "n" : v;
        }
      }
    }
    process.stdout.write(_safeStringify(entry) + "\n");
  } else {
    const prefix = `[${new Date(ts * 1000).toISOString()}] [${level.toUpperCase()}]`;
    const extraStr = extra && typeof extra === "object" && Object.keys(extra).length > 0
      ? " " + _safeStringify(extra)
      : "";
    const out = `${prefix} ${msg}${extraStr}\n`;
    if (level === "error" || level === "warn") {
      process.stderr.write(out);
    } else {
      process.stdout.write(out);
    }
  }
}

export const log = {
  info: (msg, extra) => _write("info", msg, extra),
  warn: (msg, extra) => _write("warn", msg, extra),
  error: (msg, extra) => _write("error", msg, extra),
  debug: (msg, extra) => {
    if (process.env.LOG_LEVEL === "debug") _write("debug", msg, extra);
  }
};
