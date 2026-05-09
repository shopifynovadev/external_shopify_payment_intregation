import { createHash } from "crypto";
import prisma from "../db.server.js";
import { paymentQueue } from "../queues/index.js";
import { createPayment } from "./bkash.service.js";
import { verifyShippingRate } from "./shipping.service.js";
import { validateDiscount } from "./discount.service.js";

// TTL for pending payments: 30 minutes
const PAYMENT_TTL_MS = 30 * 60 * 1000;

function makeIdempotencyKey(cartId, shopDomain) {
  return createHash("sha256").update(`${cartId}:${shopDomain}:${Date.now()}`).digest("hex");
}

export async function initiatePayment({
  shopDomain,
  cartId,
  shippingHandle,
  discountCode,
  customerInfo,
  lineItems,
  subtotal,
  accessToken,
}) {
  // Idempotency: if a PENDING payment for this exact cart already exists (within last 5 min), return it
  const existing = await prisma.pendingPayment.findFirst({
    where: {
      shopDomain,
      status: "PENDING",
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      cartSnapshot: { path: ["cartId"], equals: cartId },
    },
  });

  if (existing) {
    return { paymentId: existing.id, redirectUrl: existing.cartSnapshot.bkashURL };
  }

  // Verify shipping rate server-side — never trust the price from the browser
  const shipping = await verifyShippingRate({ shopDomain, cartId, shippingHandle });

  // Validate discount if provided
  let discountAmount = 0;
  let discountValid = false;
  if (discountCode) {
    const result = await validateDiscount({
      shopDomain,
      code: discountCode,
      cartSubtotal: subtotal,
      accessToken,
    });
    if (!result.valid) {
      throw Object.assign(new Error(result.reason), { code: "INVALID_DISCOUNT" });
    }
    discountAmount = result.discountAmount;
    discountValid = true;
  }

  const total = parseFloat((subtotal + shipping.price - discountAmount).toFixed(2));
  if (total <= 0) throw Object.assign(new Error("Invalid total amount"), { code: "INVALID_AMOUNT" });

  const idempotencyKey = makeIdempotencyKey(cartId, shopDomain);

  // Call bKash via queue — prevents duplicate payments
  const { paymentID, bkashURL } = await paymentQueue.enqueue(() =>
    createPayment({
      shopDomain,
      amount: total,
      merchantInvoiceNumber: idempotencyKey.slice(0, 55), // bKash max length
    })
  );

  const cartSnapshot = {
    cartId,
    lineItems,
    subtotal,
    shippingHandle,
    shippingTitle: shipping.title,
    shippingPrice: shipping.price,
    discountCode: discountValid ? discountCode : null,
    discountAmount,
    total,
    bkashURL,
  };

  const pending = await prisma.pendingPayment.create({
    data: {
      shopDomain,
      idempotencyKey,
      bkashPaymentId: paymentID,
      status: "PENDING",
      cartSnapshot,
      customerInfo,
      totalAmount: total,
      expiresAt: new Date(Date.now() + PAYMENT_TTL_MS),
    },
  });

  return { paymentId: pending.id, redirectUrl: bkashURL };
}

export async function getPaymentStatus(paymentId) {
  const payment = await prisma.pendingPayment.findUnique({
    where: { id: paymentId },
    include: { order: { select: { shopifyOrderNumber: true, bkashTransactionId: true } } },
  });

  if (!payment) return null;

  return {
    status: payment.status,
    shopifyOrderNumber: payment.order?.shopifyOrderNumber ?? null,
    bkashTransactionId: payment.order?.bkashTransactionId ?? null,
    errorMessage: payment.errorDetails ?? null,
  };
}
