import { openDb } from "./db.js";

/**
 * W16: Subscription expiry tracking for SubscriptionAction events.
 *
 * Schema is created in openDb() via the subscriptions table.
 * This module provides:
 *   - indexSubscriptionEvent(event): INSERT OR REPLACE into subscriptions
 *   - getExpiringSubscriptions(withinSeconds): SELECT WHERE expires_at < now + withinSeconds AND notified = 0
 *   - markNotified(nftContract, tokenId): UPDATE notified = 1
 */

/**
 * Index a SubscriptionGranted event into the subscriptions table.
 *
 * @param {object} event
 * @param {string} event.tokenId
 * @param {string} event.nftContract
 * @param {string} event.subscriber
 * @param {number|string} event.expiresAt  — Unix timestamp (seconds)
 * @param {string} [event.itemId]
 */
export function indexSubscriptionEvent({ tokenId, nftContract, subscriber, expiresAt, itemId = null }) {
  const db = openDb();
  db.prepare(`
    INSERT OR REPLACE INTO subscriptions
      (token_id, nft_contract, subscriber, expires_at, item_id, notified)
    VALUES
      (?, ?, ?, ?, ?, 0)
  `).run(
    String(tokenId),
    String(nftContract).toLowerCase(),
    String(subscriber).toLowerCase(),
    Number(expiresAt),
    itemId != null ? String(itemId) : null
  );
}

/**
 * Return subscriptions expiring within the next `withinSeconds` seconds
 * that have not yet been notified.
 *
 * @param {number} withinSeconds
 * @returns {Array<{token_id, nft_contract, subscriber, expires_at, item_id, notified}>}
 */
export function getExpiringSubscriptions(withinSeconds) {
  const db = openDb();
  const deadline = Math.floor(Date.now() / 1000) + withinSeconds;
  return db.prepare(`
    SELECT token_id, nft_contract, subscriber, expires_at, item_id, notified
    FROM subscriptions
    WHERE expires_at < ? AND notified = 0
    ORDER BY expires_at ASC
  `).all(deadline);
}

/**
 * Mark a subscription as notified so it won't be returned again.
 *
 * @param {string} nftContract
 * @param {string} tokenId
 */
export function markNotified(nftContract, tokenId) {
  const db = openDb();
  db.prepare(`
    UPDATE subscriptions SET notified = 1
    WHERE nft_contract = ? AND token_id = ?
  `).run(
    String(nftContract).toLowerCase(),
    String(tokenId)
  );
}
