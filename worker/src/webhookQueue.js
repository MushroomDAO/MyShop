// W6: Webhook retry queue with exponential backoff
// Backed by SQLite; survives process restarts.
import { openDb } from "./db.js";
import { log } from "./logger.js";

const BACKOFF_SECONDS = [60, 300, 900, 3600, 14400]; // 1m, 5m, 15m, 1h, 4h
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

export function enqueueWebhook(url, payload) {
  const db = openDb();
  db.prepare("INSERT INTO webhook_queue (url, payload, next_attempt_at) VALUES (?, ?, ?)")
    .run(url, JSON.stringify(payload), Math.floor(Date.now() / 1000));
}

export async function processWebhookQueue() {
  const db = openDb();
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(
    "SELECT * FROM webhook_queue WHERE delivered_at IS NULL AND next_attempt_at <= ? LIMIT 20"
  ).all(now);

  for (const row of rows) {
    try {
      const res = await fetch(row.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: row.payload,
        signal: AbortSignal.timeout(10_000)
      });
      if (res.ok) {
        db.prepare("UPDATE webhook_queue SET delivered_at = ? WHERE id = ?")
          .run(now, row.id);
        log.info("webhook delivered", { id: row.id, url: row.url });
      } else {
        _scheduleRetry(db, row, `HTTP ${res.status}`);
      }
    } catch (e) {
      _scheduleRetry(db, row, e?.message ?? "fetch_error");
    }
  }
}

function _scheduleRetry(db, row, error) {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE webhook_queue SET attempts = ?, last_error = ?, delivered_at = -1 WHERE id = ?")
      .run(attempts, error, row.id); // delivered_at=-1 means permanently failed
    log.warn("webhook permanently failed", { id: row.id, url: row.url, error });
    return;
  }
  const delay = BACKOFF_SECONDS[attempts - 1] ?? 14400;
  const nextAt = Math.floor(Date.now() / 1000) + delay;
  db.prepare("UPDATE webhook_queue SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
    .run(attempts, error, nextAt, row.id);
  log.warn("webhook retry scheduled", { id: row.id, url: row.url, attempt: attempts, nextAt });
}
