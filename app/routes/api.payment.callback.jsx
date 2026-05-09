import { redirect } from "react-router";
import prisma from "../db.server.js";
import { executePayment } from "../services/bkash.service.js";
import { processOrderCreation } from "../services/orderCreate.service.js";

export async function loader({ request }) {
  const url = new URL(request.url);
  const paymentID = url.searchParams.get("paymentID");
  const status = url.searchParams.get("status");

  if (!paymentID) {
    return redirect(`/?payment_error=missing_payment_id`);
  }

  const pending = await prisma.pendingPayment.findUnique({ where: { bkashPaymentId: paymentID } });

  if (!pending) {
    return redirect(`/?payment_error=not_found`);
  }

  const { shopDomain, id: pendingPaymentId } = pending;
  const thankyouBase = `https://${shopDomain}/pages/thank-you`;
  const cartBase = `https://${shopDomain}/cart`;

  if (status === "cancel" || status === "failure") {
    await prisma.pendingPayment.update({
      where: { id: pendingPaymentId },
      data: { status: "FAILED", errorDetails: `bKash callback status: ${status}` },
    });
    return redirect(`${cartBase}?payment_id=${pendingPaymentId}&payment_status=failed`);
  }

  // Already completed — safe redirect
  if (pending.status === "COMPLETED") {
    const order = await prisma.order.findUnique({ where: { pendingPaymentId } });
    return redirect(`${thankyouBase}?payment_id=${pendingPaymentId}&order=${order?.shopifyOrderNumber ?? ""}`);
  }

  // Mark as AWAITING_EXECUTE (idempotent — only if still PENDING)
  if (pending.status === "PENDING") {
    await prisma.pendingPayment.update({
      where: { id: pendingPaymentId },
      data: { status: "AWAITING_EXECUTE" },
    });
  }

  const result = await executePayment({ shopDomain, paymentID });

  if (!result.success) {
    await prisma.pendingPayment.update({
      where: { id: pendingPaymentId },
      data: { status: "FAILED", errorDetails: result.reason },
    });
    return redirect(`${cartBase}?payment_id=${pendingPaymentId}&payment_status=failed`);
  }

  await prisma.pendingPayment.update({
    where: { id: pendingPaymentId },
    data: { bkashExecuteResponse: result.raw },
  });

  // Fire order creation — non-blocking, customer gets redirected immediately
  processOrderCreation({
    pendingPaymentId,
    shopDomain,
    bkashTrxID: result.trxID,
    amount: result.amount,
  }).catch((err) => console.error(`[orderCreate] pendingPaymentId=${pendingPaymentId}:`, err.message));

  return redirect(`${thankyouBase}?payment_id=${pendingPaymentId}`);
}
