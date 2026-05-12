/**
 * Test: Per-shop order-create rate limiting (section 10.3 / 10.4)
 *
 * Verifies that the orderCreate queue enforces 500ms spacing per shop
 * (= 2 req/s, matching Shopify's leaky bucket limit) and that different
 * shops process in parallel without blocking each other.
 *
 * How it works:
 *   - We directly call processOrderCreation from the service (bypasses HTTP)
 *   - We record the timestamp each Shopify Admin API call would fire
 *   - We check that same-shop calls are >= 500ms apart
 *   - We check that different-shop calls run simultaneously
 *
 * Usage (run from repo root):
 *   node test/concurrency/02-order-create-rate-limit.js
 *
 * NOTE: This test does NOT hit bKash or Shopify — it stubs the Admin API
 * call and measures queue timing only.
 */

import { orderCreateQueue } from "../../app/queues/index.js";

const EXPECTED_INTERVAL_MS = 500;
const TOLERANCE_MS = 100;

async function recordedTask(shopDomain, taskId, log) {
  return orderCreateQueue.enqueue(shopDomain, async () => {
    const ts = Date.now();
    log.push({ shopDomain, taskId, ts });
    // Simulate minimal work (real order creation takes ~1-2s)
    await new Promise((r) => setTimeout(r, 50));
  });
}

async function testSameShopSpacing() {
  console.log("\n--- Same shop: 3 sequential tasks should be >= 500ms apart ---");
  const log = [];
  const shop = "shop-a.myshopify.com";

  await Promise.all([
    recordedTask(shop, 1, log),
    recordedTask(shop, 2, log),
    recordedTask(shop, 3, log),
  ]);

  log.sort((a, b) => a.ts - b.ts);
  let passed = true;

  for (let i = 1; i < log.length; i++) {
    const gap = log[i].ts - log[i - 1].ts;
    const ok = gap >= EXPECTED_INTERVAL_MS - TOLERANCE_MS;
    console.log(
      `  Task ${log[i - 1].taskId} → Task ${log[i].taskId}: gap=${gap}ms ${ok ? "[OK]" : "[FAIL — too fast]"}`
    );
    if (!ok) passed = false;
  }
  return passed;
}

async function testDifferentShopsParallel() {
  console.log("\n--- Different shops: tasks should run in parallel (not block each other) ---");
  const log = [];
  const shopA = "shop-a.myshopify.com";
  const shopB = "shop-b.myshopify.com";

  const wallStart = Date.now();
  await Promise.all([
    recordedTask(shopA, "A1", log),
    recordedTask(shopB, "B1", log),
    recordedTask(shopA, "A2", log),
    recordedTask(shopB, "B2", log),
  ]);
  const wallTime = Date.now() - wallStart;

  // If shops are independent, wall time ≈ 2 * 500ms (2 tasks each, 500ms apart)
  // If shops block each other, wall time ≈ 4 * 500ms = 2000ms
  const passed = wallTime < 1200; // 2 shops × 500ms + generous slack
  console.log(`  Wall time: ${wallTime}ms — expected < 1200ms (shops run independently)`);
  console.log(`  ${passed ? "[OK]" : "[FAIL — shops appear to be blocking each other]"}`);
  return passed;
}

(async () => {
  const r1 = await testSameShopSpacing();
  const r2 = await testDifferentShopsParallel();

  if (r1 && r2) {
    console.log("\n✓ Rate limit tests passed");
  } else {
    console.error("\n✗ Rate limit tests failed");
    process.exit(1);
  }
})();
