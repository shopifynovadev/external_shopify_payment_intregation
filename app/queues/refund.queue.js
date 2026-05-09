import PQueue from "p-queue";

// Concurrency 5 — bKash refund calls
const queue = new PQueue({ concurrency: 5 });

export const refundQueue = {
  enqueue: (fn) => queue.add(fn),
  getStats: () => ({ size: queue.size, pending: queue.pending }),
};
