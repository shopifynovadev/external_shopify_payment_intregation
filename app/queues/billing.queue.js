import PQueue from "p-queue";

// Concurrency 2 — monthly invoice generation, runs off-peak
const queue = new PQueue({ concurrency: 2 });

export const billingQueue = {
  enqueue: (fn) => queue.add(fn),
  getStats: () => ({ size: queue.size, pending: queue.pending }),
};
