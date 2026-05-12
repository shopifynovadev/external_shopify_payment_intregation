/**
 * Test: Callback race condition (section 10.5)
 *
 * Fires 2 simultaneous GET /api/payment/callback?paymentID=X&status=success
 * for the SAME paymentID to simulate a user refreshing the callback URL.
 *
 * Expected: Only ONE bKash executePayment call is made.
 *           The second request hits the "already AWAITING_EXECUTE" or "already COMPLETED" guard
 *           and redirects cleanly without double-executing.
 *
 * How to verify:
 *   - Check server logs for exactly one "[bKash] execute" call for this paymentID
 *   - Check DB: PendingPayment status = COMPLETED (not duplicated)
 *   - Check DB: Order table has exactly ONE order for this pendingPaymentId
 *
 * Prerequisites:
 *   1. Run test 2.1 (Initiate) in Postman to get a bkash_payment_id
 *   2. Complete the payment in bKash sandbox (so executePayment will succeed)
 *   3. Copy the bkashPaymentId and set BKASH_PAYMENT_ID env var
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 BKASH_PAYMENT_ID=xxxxx \
 *   node test/concurrency/03-callback-race.js
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const BKASH_PAYMENT_ID = process.env.BKASH_PAYMENT_ID;

if (!BKASH_PAYMENT_ID) {
  console.error("ERROR: Set BKASH_PAYMENT_ID env var (from a completed bKash sandbox payment)");
  process.exit(1);
}

async function hitCallback() {
  const start = Date.now();
  // fetch follows redirects by default — record final URL
  const res = await fetch(
    `${BASE_URL}/api/payment/callback?paymentID=${BKASH_PAYMENT_ID}&status=success`,
    { redirect: "follow" }
  );
  return { status: res.status, finalUrl: res.url, durationMs: Date.now() - start };
}

(async () => {
  console.log(`\n--- Firing 2 simultaneous callbacks for paymentID=${BKASH_PAYMENT_ID} ---`);

  const [r1, r2] = await Promise.all([hitCallback(), hitCallback()]);

  console.log(`  Request 1: status=${r1.status} url=${r1.finalUrl} (${r1.durationMs}ms)`);
  console.log(`  Request 2: status=${r2.status} url=${r2.finalUrl} (${r2.durationMs}ms)`);

  const bothRedirected = [r1.status, r2.status].every((s) => s >= 200 && s < 400);
  console.log(`\n  Both redirected cleanly: ${bothRedirected ? "[OK]" : "[FAIL]"}`);

  const neitherErrored = ![r1.finalUrl, r2.finalUrl].some((u) => u.includes("payment_error"));
  console.log(`  Neither hit an error redirect: ${neitherErrored ? "[OK]" : "[FAIL]"}`);

  console.log(`
Manual verification (check in DB or server logs):
  SELECT status, COUNT(*) FROM orders WHERE pending_payment_id = (
    SELECT id FROM pending_payments WHERE bkash_payment_id = '${BKASH_PAYMENT_ID}'
  ) GROUP BY status;
  -- Expected: exactly 1 row with status = PAID

  SELECT COUNT(*) FROM orders WHERE pending_payment_id = (
    SELECT id FROM pending_payments WHERE bkash_payment_id = '${BKASH_PAYMENT_ID}'
  );
  -- Expected: 1 (not 2)
  `);

  if (!bothRedirected || !neitherErrored) process.exit(1);
})();
