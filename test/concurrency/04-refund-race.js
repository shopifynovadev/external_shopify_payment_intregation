/**
 * Test: Simultaneous refund webhooks for same shopifyRefundId (section 10.6)
 *
 * Fires 3 simultaneous POST /webhooks/orders/refunded with the SAME shopifyRefundId.
 * Verifies:
 *   - All 3 return 200 (Shopify always gets 200 so it stops retrying)
 *   - Only ONE Refund row in DB (upsert is idempotent)
 *   - bKash refundPayment is called exactly once (not 3 times)
 *
 * Prerequisites:
 *   - A completed order in your DB (get shopify_order_id from orders table)
 *   - SHOPIFY_API_SECRET set (for HMAC signing)
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   SHOPIFY_API_SECRET=your_secret \
 *   SHOPIFY_ORDER_GID="gid://shopify/Order/123456" \
 *   node test/concurrency/04-refund-race.js
 */

import { createHmac } from "crypto";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_ORDER_GID = process.env.SHOPIFY_ORDER_GID;

if (!SHOPIFY_API_SECRET || !SHOPIFY_ORDER_GID) {
  console.error("ERROR: Set SHOPIFY_API_SECRET and SHOPIFY_ORDER_GID env vars");
  process.exit(1);
}

// Use a fixed refundId so all 3 requests simulate the same Shopify retry
const SHOPIFY_REFUND_ID = `gid://shopify/Refund/race-test-${Date.now()}`;

const PAYLOAD = JSON.stringify({
  id: 1,
  admin_graphql_api_id: SHOPIFY_ORDER_GID,
  refunds: [
    {
      id: 1,
      admin_graphql_api_id: SHOPIFY_REFUND_ID,
      note: "Race condition test",
      transactions: [{ id: 1, amount: "100.00" }],
    },
  ],
});

function sign(body) {
  return createHmac("sha256", SHOPIFY_API_SECRET).update(body).digest("base64");
}

async function sendWebhook() {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/webhooks/orders/refunded`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": "orders/refunded",
      "X-Shopify-Shop-Domain": process.env.SHOP_DOMAIN || "test.myshopify.com",
      "X-Shopify-Hmac-SHA256": sign(PAYLOAD),
    },
    body: PAYLOAD,
  });
  return { status: res.status, durationMs: Date.now() - start };
}

(async () => {
  console.log(`\n--- Firing 3 simultaneous refund webhooks for refundId=${SHOPIFY_REFUND_ID} ---`);

  const results = await Promise.all([sendWebhook(), sendWebhook(), sendWebhook()]);

  let allOk = true;
  for (const [i, r] of results.entries()) {
    const ok = r.status === 200;
    console.log(`  Webhook ${i + 1}: status=${r.status} (${r.durationMs}ms) ${ok ? "[OK]" : "[FAIL]"}`);
    if (!ok) allOk = false;
  }

  console.log(`
Manual verification (check in DB):
  SELECT COUNT(*) FROM refunds
  WHERE shopify_refund_id = '${SHOPIFY_REFUND_ID}';
  -- Expected: exactly 1 (not 3)

  SELECT status FROM refunds
  WHERE shopify_refund_id = '${SHOPIFY_REFUND_ID}';
  -- Expected: PENDING → COMPLETED (or FAILED if bKash sandbox unavailable)

Check server logs for:
  "[refundQueue]" lines — should appear exactly once for this refund ID
  `);

  if (!allOk) process.exit(1);
  console.log("✓ All webhooks returned 200 — check DB for idempotency verification");
})();
