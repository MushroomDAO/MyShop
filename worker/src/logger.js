// Minimal structured logger (JSON lines to stdout/stderr)
function _write(level, msg, meta) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  info: (msg, meta = {}) => _write("info", msg, meta),
  warn: (msg, meta = {}) => _write("warn", msg, meta),
  error: (msg, meta = {}) => _write("error", msg, meta)
};
