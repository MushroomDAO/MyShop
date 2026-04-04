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

    CREATE TABLE IF NOT EXISTS issued_nonces (
      item_id TEXT NOT NULL,
      buyer TEXT NOT NULL,
      nonce TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, buyer, nonce)
    );
  `);

  _db = db;
  return db;
}

export function getDbPath() {
  return DB_PATH;
}
