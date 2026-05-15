import prisma from "../db.server.js";
import { orderCreateQueue } from "../queues/index.js";
import { refundPayment } from "./bkash.service.js";

const ORDER_CREATE = `
  mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name }
      userErrors { field message }
    }
  }
`;

async function adminGraphQL({ shopDomain, accessToken, query, variables }) {
  const res = await fetch(
    `https://${shopDomain}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) throw new Error(`Admin API HTTP error: ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function createShopifyOrder({ shopDomain, accessToken, pendingPayment, bkashTrxID }) {
  const snap = pendingPayment.cartSnapshot;
  const customer = pendingPayment.customerInfo;
  const pct = snap.paymentPercentage ?? 100;
  const paidAmount = snap.chargedAmount ?? snap.total;
  const isFullPayment = pct === 100;

  const paymentNote = isFullPayment
    ? `bKash Transaction ID: ${bkashTrxID}`
    : `bKash Transaction ID: ${bkashTrxID}\nPaid via bKash: ৳${paidAmount} of ৳${snap.total} (${pct}%)\nRemaining balance: ৳${parseFloat((snap.total - paidAmount).toFixed(2))}`;

  const order = {
    lineItems: snap.lineItems.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    shippingLines: [
      {
        title: snap.shippingTitle,
        priceSet: {
          shopMoney: { amount: String(snap.shippingPrice), currencyCode: "BDT" },
          presentmentMoney: { amount: String(snap.shippingPrice), currencyCode: "BDT" },
        },
      },
    ],
    shippingAddress: {
      firstName: customer.name.split(" ")[0],
      lastName: customer.name.split(" ").slice(1).join(" ") || "-",
      phone: customer.phone,
      address1: customer.address.street ?? "-",
      city: customer.address.district,
      countryCode: "BD",
      zip: "0000",
    },
    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        amountSet: {
          shopMoney: { amount: String(paidAmount), currencyCode: "BDT" },
          presentmentMoney: { amount: String(paidAmount), currencyCode: "BDT" },
        },
      },
    ],
    tags: isFullPayment
      ? [`nova-bkash`, `bkash-trx:${bkashTrxID}`]
      : [`nova-bkash`, `bkash-trx:${bkashTrxID}`, `partial-payment-${pct}pct`],
    note: paymentNote,
    ...(customer.email ? { email: customer.email } : {}),
    ...(snap.discountCode ? { discountCodes: [snap.discountCode] } : {}),
  };

  const data = await adminGraphQL({
    shopDomain,
    accessToken,
    query: ORDER_CREATE,
    variables: {
      order,
      options: { sendReceipt: !!customer.email },
    },
  });

  const userErrors = data.orderCreate?.userErrors ?? [];
  if (userErrors.length) throw new Error(userErrors[0].message);

  const createdOrder = data.orderCreate.order;

  return {
    shopifyOrderId: createdOrder.id,
    shopifyOrderNumber: createdOrder.name,
    paidAmount,
    paymentPercentage: pct,
  };
}

export async function processOrderCreation({ pendingPaymentId, shopDomain, bkashTrxID, amount }) {
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session) throw new Error(`No offline session found for ${shopDomain}`);

  const pendingPayment = await prisma.paymentWithNoShopifyOrders.findUnique({
    where: { id: pendingPaymentId },
  });

  if (!pendingPayment) throw new Error("PendingPayment not found");
  if (pendingPayment.status === "COMPLETED") return; // idempotent

  const snap = pendingPayment.cartSnapshot;

  // Hard reject if amounts don't match — for partial payments compare chargedAmount, not full total
  const expectedAmount = snap.chargedAmount ?? snap.total;
  const difference = Math.abs(parseFloat(amount) - parseFloat(expectedAmount));
  if (difference > 1) {
    await prisma.paymentWithNoShopifyOrders.update({
      where: { id: pendingPaymentId },
      data: { status: "FAILED", errorDetails: `Amount mismatch: expected ${expectedAmount}, got ${amount}` },
    });
    // Auto-refund the bKash charge
    const amountMismatchRefund = await refundPayment({
      shopDomain,
      paymentID: pendingPayment.bkashPaymentId,
      trxID: bkashTrxID,
      amount,
      reason: "Amount mismatch — auto refund",
    });
    if (!amountMismatchRefund.success) {
      console.error(`[CRITICAL] Refund failed for pendingPaymentId=${pendingPaymentId} reason=${amountMismatchRefund.reason}`);
      await prisma.paymentWithNoShopifyOrders.update({
        where: { id: pendingPaymentId },
        data: { errorDetails: `Amount mismatch + REFUND_FAILED: ${amountMismatchRefund.reason}` },
      });
    }
    return;
  }

  // Enqueue per-shop (rate-limited to Shopify's 2 req/s)
  await orderCreateQueue.enqueue(shopDomain, async () => {
    let shopifyOrderData;
    let lastError;

    // Retry up to 3 times with exponential backoff for transient Shopify errors
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        shopifyOrderData = await createShopifyOrder({
          shopDomain,
          accessToken: session.accessToken,
          pendingPayment,
          bkashTrxID,
        });
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }

    if (!shopifyOrderData) {
      // bKash payment was successful but Shopify order creation failed.
      // Do NOT refund — merchant will handle manually via the Payment Issues tab.
      await prisma.paymentWithNoShopifyOrders.update({
        where: { id: pendingPaymentId },
        data: {
          status: "ORDER_FAILED",
          errorDetails: lastError?.message ?? "Shopify order creation failed after 3 attempts",
        },
      });
      console.error(`[ORDER_FAILED] bKash paid but no Shopify order. pendingPaymentId=${pendingPaymentId} bkashTrxID=${bkashTrxID}`);
      return;
    }

    const { shopifyOrderId, shopifyOrderNumber, paidAmount, paymentPercentage } = shopifyOrderData;

    // Persist order and upsert daily summary atomically
    await prisma.$transaction(async (tx) => {
      await tx.order.create({
        data: {
          shopDomain,
          shopifyOrderId,
          shopifyOrderNumber,
          shopifyDraftOrderId: null,
          pendingPaymentId,
          bkashTransactionId: bkashTrxID,
          totalAmount: snap.total,
          paidAmount,
          paymentPercentage,
          shopifyPaymentStatus: paidAmount >= snap.total ? "PAID" : "PARTIALLY_PAID",
          status: "PAID",
          customerName: pendingPayment.customerInfo.name,
          customerPhone: pendingPayment.customerInfo.phone,
          customerEmail: pendingPayment.customerInfo.email ?? null,
          deliveryAddress: pendingPayment.customerInfo.address,
          shippingTitle: snap.shippingTitle,
          shippingPrice: snap.shippingPrice,
          discountCode: snap.discountCode ?? null,
          discountAmount: snap.discountAmount > 0 ? snap.discountAmount : null,
        },
      });

      // Upsert daily aggregate (for billing + revenue chart)
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      await tx.orderSummary.upsert({
        where: { shopDomain_date: { shopDomain, date: today } },
        update: {
          orderCount: { increment: 1 },
          totalAmount: { increment: snap.total },
        },
        create: {
          shopDomain,
          date: today,
          orderCount: 1,
          totalAmount: snap.total,
        },
      });

      await tx.paymentWithNoShopifyOrders.update({
        where: { id: pendingPaymentId },
        data: { status: "COMPLETED" },
      });
    });
  });
}
