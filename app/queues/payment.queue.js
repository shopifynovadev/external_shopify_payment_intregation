import PQueue from "p-queue";

// Concurrency 10 — bKash payment create/execute calls
const queue = new PQueue({ concurrency: 10 });

export const paymentQueue = {
  enqueue: (fn) => queue.add(fn),
  getStats: () => ({ size: queue.size, pending: queue.pending }),
};
