import PQueue from "p-queue";

// SHOPIFY_QUEUE_INTERVAL_MS: gap between Shopify API calls per shop
// 500ms = 2 req/s (safe for all plans)
// 200ms = 5 req/s (Advanced/Plus plans)
const INTERVAL_MS = parseInt(process.env.SHOPIFY_QUEUE_INTERVAL_MS ?? "500");

const shopQueues = new Map();

function getShopQueue(shopDomain) {
  if (!shopQueues.has(shopDomain)) {
    shopQueues.set(
      shopDomain,
      new PQueue({ concurrency: 1, interval: INTERVAL_MS, intervalCap: 1 })
    );
  }
  return shopQueues.get(shopDomain);
}

export const shopifyQueue = {
  enqueue: (shopDomain, fn) => getShopQueue(shopDomain).add(fn),
  size: (shopDomain) => shopQueues.get(shopDomain)?.size ?? 0,
};
