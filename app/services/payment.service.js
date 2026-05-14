import { createHash } from "crypto";
import prisma from "../db.server.js";
import { paymentQueue } from "../queues/index.js";
import { createPayment } from "./bkash.service.js";
import { validateDiscount } from "./discount.service.js";
import { resolveShippingRate } from "../models/shippingRate.server.js";
import { getShippingConfig, calculateShipping } from "./shipping.service.js";

const PAYMENT_TTL_MS = 30 * 60 * 1000;

function makeIdempotencyKey(phone, shopDomain) {
  return createHash("sha256").update(`${phone}:${shopDomain}:${Date.now()}`).digest("hex");
}

function toKg(value, unit) {
  switch (unit) {
    case "KILOGRAMS": return value;
    case "GRAMS":     return value / 1000;
    case "POUNDS":    return value * 0.453592;
    case "OUNCES":    return value * 0.0283495;
    default:          return value;
  }
}

async function fetchVariantData({ shopDomain, accessToken, lineItems }) {
  const ids = lineItems.map(item => item.variantId);

  const res = await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `query GetVariantData($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            price
            weight
            weightUnit
          }
        }
      }`,
      variables: { ids },
    }),
  });

  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const variantMap = {};
  for (const node of json.data.nodes ?? []) {
    if (node?.id) {
      variantMap[node.id] = {
        price: parseFloat(node.price),
        kg: toKg(node.weight ?? 0, node.weightUnit ?? "KILOGRAMS"),
      };
    }
  }
  return variantMap;
}

export async function initiatePayment({
  shopDomain,
  shippingRate,
  shippingSource = "db",
  discountCode,
  customerInfo,
  lineItems,
  paymentPercentage = 100,
  accessToken,
}) {
  const pct = Number(paymentPercentage);
  if (isNaN(pct) || pct <= 0 || pct > 100) {
    throw Object.assign(new Error("paymentPercentage must be a number between 1 and 100"), { code: "INVALID_PERCENTAGE" });
  }

  const existing = await prisma.pendingPayment.findFirst({
    where: {
      shopDomain,
      status: "PENDING",
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      customerInfo: { path: ["phone"], equals: customerInfo.phone },
    },
  });

  if (existing) {
    return { paymentId: existing.id, redirectUrl: existing.cartSnapshot.bkashURL };
  }

  // One Shopify API call — price for subtotal verification + weight for shipping
  const variantMap = await fetchVariantData({ shopDomain, accessToken, lineItems });

  let subtotal = 0;
  const lineItemsWithKg = lineItems.map(item => {
    const variant = variantMap[item.variantId];
    if (!variant) {
      throw Object.assign(new Error(`Variant not found: ${item.variantId}`), { code: "INVALID_VARIANT" });
    }
    if (item.price != null && Math.abs(item.price - variant.price) > 1) {
      throw Object.assign(new Error(`Price mismatch on variant ${item.variantId}`), { code: "PRICE_TAMPERED" });
    }
    subtotal += variant.price * item.quantity;
    return { ...item, kg: variant.kg };
  });
  subtotal = parseFloat(subtotal.toFixed(2));

  // Resolve shipping
  let shippingTitle = "No Shipping";
  let shippingPrice = 0;

  if (shippingSource === "shopify") {
    const config = await getShippingConfig({ shopDomain, accessToken, noCache: true });
    const result = calculateShipping({
      config,
      lineItemsWithKg,
      namedRateTitle: shippingRate?.title ?? null,
      expectedTotal: shippingRate?.expectedTotal ?? 0,
    });
    shippingTitle = result.shippingTitle;
    shippingPrice = result.shippingPrice;
  } else if (shippingRate?.code) {
    const resolved = await resolveShippingRate({
      id: shippingRate.code,
      shopDomain,
      orderTotal: subtotal,
    });
    if (!resolved) {
      throw Object.assign(new Error("Invalid or inactive shipping rate"), { code: "INVALID_SHIPPING" });
    }
    shippingTitle = resolved.title;
    shippingPrice = resolved.price;
  }

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

  const total = parseFloat((subtotal + shippingPrice - discountAmount).toFixed(2));
  if (total <= 0) throw Object.assign(new Error("Invalid total amount"), { code: "INVALID_AMOUNT" });

  const chargedAmount = parseFloat((total * pct / 100).toFixed(2));

  const idempotencyKey = makeIdempotencyKey(customerInfo.phone, shopDomain);

  const { paymentID, bkashURL } = await paymentQueue.enqueue(() =>
    createPayment({
      shopDomain,
      amount: chargedAmount,
      merchantInvoiceNumber: idempotencyKey.slice(0, 55),
    })
  );

  const cartSnapshot = {
    lineItems,
    subtotal,
    shippingTitle,
    shippingPrice,
    discountCode: discountValid ? discountCode : null,
    discountAmount,
    total,
    paymentPercentage: pct,
    chargedAmount,
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
