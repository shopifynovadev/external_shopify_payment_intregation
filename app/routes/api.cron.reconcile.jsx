
import prisma from "../db.server.js";

function authorized(request) {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

const ORDERS_QUERY = `
  query GetNovaBkashOrders($query: String!, $cursor: String) {
    orders(first: 250, query: $query, after: $cursor) {
      edges {
        node {
          id
          name
          createdAt
          tags
          totalPriceSet { shopMoney { amount } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchShopifyOrders({ shopDomain, accessToken, sinceDate }) {
  const query = `tag:nova-bkash AND created_at:>='${sinceDate}'`;
  const orders = [];
  let cursor = null;

  do {
    const res = await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: ORDERS_QUERY, variables: { query, cursor } }),
    });

    const { data } = await res.json();
    const page = data?.orders;
    if (!page) break;

    orders.push(...page.edges.map((e) => e.node));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return orders;
}

async function reconcileMerchant(merchant, sinceDate) {
  const session = await prisma.session.findFirst({
    where: { shop: merchant.shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session) return { shopDomain: merchant.shopDomain, skipped: true };

  const shopifyOrders = await fetchShopifyOrders({
    shopDomain: merchant.shopDomain,
    accessToken: session.accessToken,
    sinceDate,
  });

  const discrepancies = [];

  for (const shopifyOrder of shopifyOrders) {
    const ourOrder = await prisma.order.findUnique({ where: { shopifyOrderId: shopifyOrder.id } });

    if (!ourOrder) {
      discrepancies.push({ type: "MISSING_IN_DB", shopifyOrderId: shopifyOrder.id, name: shopifyOrder.name });

      await prisma.auditLog.create({
        data: {
          shopDomain: merchant.shopDomain,
          action: "RECONCILIATION_DISCREPANCY_FOUND",
          actor: "SYSTEM",
          metadata: { type: "MISSING_IN_DB", shopifyOrderId: shopifyOrder.id, orderName: shopifyOrder.name },
        },
      });
    } else {
      const shopifyAmount = parseFloat(shopifyOrder.totalPriceSet.shopMoney.amount);
      const ourAmount = parseFloat(ourOrder.totalAmount);
      if (Math.abs(shopifyAmount - ourAmount) > 0.01) {
        discrepancies.push({
          type: "AMOUNT_MISMATCH",
          shopifyOrderId: shopifyOrder.id,
          shopifyAmount,
          ourAmount,
        });
      }
    }
  }

  // Self-heal OrderSummary for yesterday if any orders were missing
  if (discrepancies.some((d) => d.type === "MISSING_IN_DB")) {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);

    const dayOrders = await prisma.order.findMany({
      where: {
        shopDomain: merchant.shopDomain,
        createdAt: {
          gte: yesterday,
          lt: new Date(yesterday.getTime() + 86400000),
        },
      },
    });

    const dayTotal = dayOrders.reduce((s, o) => s + parseFloat(o.totalAmount), 0);

    await prisma.orderSummary.upsert({
      where: { shopDomain_date: { shopDomain: merchant.shopDomain, date: yesterday } },
      update: { orderCount: dayOrders.length, totalAmount: dayTotal },
      create: {
        shopDomain: merchant.shopDomain,
        date: yesterday,
        orderCount: dayOrders.length,
        totalAmount: dayTotal,
      },
    });
  }

  return { shopDomain: merchant.shopDomain, shopifyOrders: shopifyOrders.length, discrepancies };
}

export async function action({ request }) {
  if (!authorized(request)) {
    return ({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const sinceDate = yesterday.toISOString().split("T")[0];

  const merchants = await prisma.merchantSettings.findMany({ where: { isActive: true } });

  const results = await Promise.allSettled(
    merchants.map((m) => reconcileMerchant(m, sinceDate))
  );

  return ({
    success: true,
    data: results.map((r) => (r.status === "fulfilled" ? r.value : { error: r.reason?.message })),
  });
}
