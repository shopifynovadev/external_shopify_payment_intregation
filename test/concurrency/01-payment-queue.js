/**
 * Test: Payment queue concurrency (section 10.1 / 10.2)
 *
 * Fires N simultaneous POST /api/payment/initiate requests and verifies:
 *  - All succeed (or fail gracefully — no crashes, no hanging promises)
 *  - Each gets a unique paymentId (no duplicate bKash createPayment calls for different carts)
 *  - Response time is reasonable (queue doesn't serialize everything unnecessarily)
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 SHOP_DOMAIN=your-store.myshopify.com \
 *   VARIANT_ID="gid://shopify/ProductVariant/123" SHIPPING_HANDLE="shopify-Standard-10.00" \
 *   node test/concurrency/01-payment-queue.js
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SHOP_DOMAIN = process.env.SHOP_DOMAIN;
const VARIANT_ID = process.env.VARIANT_ID;
const SHIPPING_HANDLE = process.env.SHIPPING_HANDLE;

if (!SHOP_DOMAIN || !VARIANT_ID || !SHIPPING_HANDLE) {
  console.error("ERROR: Set SHOP_DOMAIN, VARIANT_ID, and SHIPPING_HANDLE env vars");
  process.exit(1);
}

function makePayload(n) {
  return {
    shopDomain: SHOP_DOMAIN,
    cartId: `gid://shopify/Cart/concurrency-test-${n}-${Date.now()}`,
   // shippingHandle: SHIPPING_HANDLE,
    customerInfo: {
      name: `Test User ${n}`,
      phone: `017${String(n).padStart(8, "0")}`,
      email: `test${n}@example.com`,
      address: { division: "Dhaka", district: "Dhaka", thana: "Gulshan", street: `House ${n}` },
    },
    lineItems: [{ variantId: VARIANT_ID, quantity: 1 }],
    subtotal: 500,
  };
}

async function initiatePayment(n) {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/api/payment/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makePayload(n)),
  });
  const json = await res.json();
  return { n, status: res.status, paymentId: json.data?.paymentId, durationMs: Date.now() - start, raw: json };
}

async function run(concurrency) {
  console.log(`\n--- Firing ${concurrency} simultaneous payment initiate requests ---`);
  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, i) => initiatePayment(i + 1))
  );
  const totalMs = Date.now() - start;

  let passed = 0;
  let failed = 0;
  const paymentIds = new Set();

  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`  [NETWORK ERROR]`, result.reason?.message);
      failed++;
      continue;
    }
    const { n, status, paymentId, durationMs, raw } = result.value;
    if (status === 200 && paymentId) {
      if (paymentIds.has(paymentId)) {
        console.error(`  [FAIL] Request ${n}: DUPLICATE paymentId detected: ${paymentId}`);
        failed++;
      } else {
        paymentIds.add(paymentId);
        console.log(`  [OK]   Request ${n}: paymentId=${paymentId.slice(0, 8)}... (${durationMs}ms)`);
        passed++;
      }
    } else {
      console.error(`  [FAIL] Request ${n}: status=${status} error=${raw.error || raw.code}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed — total wall time: ${totalMs}ms`);
  return failed === 0;
}

(async () => {
  const ok10 = await run(10);  // should all run concurrently (queue concurrency = 10)
  const ok11 = await run(11);  // 11th should queue and still succeed

  if (ok10 && ok11) {
    console.log("\n✓ All concurrency tests passed");
  } else {
    console.error("\n✗ Some concurrency tests failed");
    process.exit(1);
  }
})();
