import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/indexer.db";

let _db = null;

export function openDb() {
  if (_db) return _db;

  const dbPath = DB_PATH;
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  // Base schema (new installs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      buyer TEXT NOT NULL,
      recipient TEXT NOT NULL,
      token_id TEXT,
      serial_hash TEXT,
      quantity TEXT NOT NULL DEFAULT '1',
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL DEFAULT 0,
      block_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT 0,
      chain_id INTEGER NOT NULL,
      pay_token TEXT,
      pay_amount TEXT,
      platform_fee_amount TEXT,
      UNIQUE(tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_buyer ON purchases(buyer);
    CREATE INDEX IF NOT EXISTS idx_purchases_shop ON purchases(shop_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_item ON purchases(item_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_block ON purchases(block_number);

    CREATE TABLE IF NOT EXISTS indexer_state (
      chain_id INTEGER PRIMARY KEY,
      last_block INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- issued_nonces_v2 includes chain_id; old issued_nonces (without chain_id) is migrated below
    CREATE TABLE IF NOT EXISTS issued_nonces_v2 (
      chain_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      buyer TEXT NOT NULL,
      nonce TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      PRIMARY KEY (chain_id, item_id, buyer, nonce)
    );

    -- W6: webhook retry queue (exponential backoff, survives restarts)
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,       -- JSON string of the event
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,  -- Unix seconds
      last_error TEXT,
      delivered_at INTEGER         -- NULL = pending; -1 = permanently failed
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_queue_pending
      ON webhook_queue(next_attempt_at) WHERE delivered_at IS NULL;
  `);

  // Migration: copy old issued_nonces (no chain_id) into issued_nonces_v2 with chain_id=0, then drop
  const oldTableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issued_nonces'")
    .get();
  if (oldTableExists) {
    db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO issued_nonces_v2 (chain_id, item_id, buyer, nonce, issued_at)
        SELECT 0, item_id, buyer, nonce, issued_at FROM issued_nonces;
        DROP TABLE issued_nonces;
      `);
    })();
  }

  // Note: we intentionally do NOT delete issued_at=0 rows on startup.
  // If a process crashed between INSERT and the final UPDATE (issued_at=now),
  // the signed permit may already be in the client's hands. Deleting the row
  // would allow the same nonce to be reissued, creating two valid permits for
  // the same nonce (only one can be used on-chain, but it's a cleaner invariant
  // to treat any inserted row as permanently consumed).

  _db = db;
  return db;
}

export function getDbPath() {
  return DB_PATH;
}
