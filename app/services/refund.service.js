import prisma from "../db.server.js";
import { refundQueue } from "../queues/index.js";
import { refundPayment } from "./bkash.service.js";

const MAX_RETRIES = 5;

async function executeRefund(refundId) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { order: { include: { pendingPayment: true } } },
  });

  if (!refund || refund.status === "COMPLETED") return;

  const { shopDomain, bkashTransactionId, refundAmount, order } = refund;
  const paymentID = order.pendingPayment?.bkashPaymentId;

  if (!paymentID) {
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: "FAILED", errorDetails: "No bKash paymentID found on pending payment" },
    });
    return;
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await refundPayment({
        shopDomain,
        paymentID,
        trxID: bkashTransactionId,
        amount: parseFloat(refundAmount),
        reason: refund.reason ?? "Merchant initiated refund",
      });

      if (result.success) {
        const isFullRefund = parseFloat(refundAmount) >= parseFloat(order.totalAmount);

        await prisma.$transaction([
          prisma.refund.update({
            where: { id: refundId },
            data: {
              status: "COMPLETED",
              bkashRefundId: result.refundTrxID,
              completedAt: new Date(),
            },
          }),
          prisma.order.update({
            where: { id: order.id },
            data: { status: isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED" },
          }),
          prisma.auditLog.create({
            data: {
              shopDomain,
              action: "REFUND_COMPLETED",
              actor: "SYSTEM",
              metadata: { refundId, bkashRefundId: result.refundTrxID, amount: refundAmount },
            },
          }),
        ]);
        return;
      }

      lastError = new Error(result.reason);
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }

  await prisma.$transaction([
    prisma.refund.update({
      where: { id: refundId },
      data: { status: "FAILED", errorDetails: lastError?.message },
    }),
    prisma.auditLog.create({
      data: {
        shopDomain,
        action: "REFUND_FAILED",
        actor: "SYSTEM",
        metadata: { refundId, error: lastError?.message },
      },
    }),
  ]);
}

export async function handleRefundWebhook({ shopifyRefundId, shopifyOrderId, refundAmount, reason }) {
  const order = await prisma.order.findUnique({ where: { shopifyOrderId } });
  if (!order) return { skip: true }; // not our order

  // Idempotency — if already completed, caller returns 200 immediately
  const existing = await prisma.refund.findUnique({ where: { shopifyRefundId } });
  if (existing?.status === "COMPLETED") return { alreadyDone: true };

  const refund = await prisma.refund.upsert({
    where: { shopifyRefundId },
    update: { status: "PENDING" },
    create: {
      shopDomain: order.shopDomain,
      orderId: order.id,
      shopifyRefundId,
      bkashTransactionId: order.bkashTransactionId,
      refundAmount,
      status: "PENDING",
      reason: reason ?? null,
    },
  });

  refundQueue.enqueue(() => executeRefund(refund.id)).catch((err) =>
    console.error(`[refundQueue] Failed for refund ${refund.id}:`, err.message)
  );

  return { queued: true };
}
