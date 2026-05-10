
import prisma from "../db.server.js";
import { paymentQueue, orderCreateQueue, refundQueue } from "../queues/index.js";

export async function loader() {
  let dbStatus = "connected";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "disconnected";
  }

  return ({
    status: dbStatus === "connected" ? "ok" : "degraded",
    db: dbStatus,
    queues: {
      payment: paymentQueue.getStats(),
      orderCreate: orderCreateQueue.getStats(),
      refund: refundQueue.getStats(),
    },
    timestamp: new Date().toISOString(),
  });
}
