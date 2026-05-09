import PQueue from "p-queue";

// Per-shop queues — Shopify allows ~2 req/s per shop (leaky bucket)
// interval: 500ms + intervalCap: 1 = max 2 req/s per shop
const shopQueues = new Map();

function getShopQueue(shopDomain) {
  if (!shopQueues.has(shopDomain)) {
    shopQueues.set(
      shopDomain,
      new PQueue({ concurrency: 1, interval: 500, intervalCap: 1 })
    );
  }
  return shopQueues.get(shopDomain);
}

export const orderCreateQueue = {
  enqueue: (shopDomain, fn) => getShopQueue(shopDomain).add(fn),
  getStats: () => ({
    shopCount: shopQueues.size,
    totalSize: [...shopQueues.values()].reduce((sum, q) => sum + q.size, 0),
    totalPending: [...shopQueues.values()].reduce((sum, q) => sum + q.pending, 0),
  }),
};
