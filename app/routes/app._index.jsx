import { useLoaderData } from "react-router";
import { json } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [recentOrders, monthlySummaries, settings] = await Promise.all([
    prisma.order.findMany({
      where: { shopDomain: shop },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        shopifyOrderNumber: true,
        customerName: true,
        totalAmount: true,
        status: true,
        bkashTransactionId: true,
        createdAt: true,
      },
    }),
    prisma.orderSummary.findMany({
      where: { shopDomain: shop, date: { gte: monthStart } },
    }),
    prisma.merchantSettings.findUnique({
      where: { shopDomain: shop },
      select: { bkashAppKey: true },
    }),
  ]);

  const monthlyGmv = monthlySummaries.reduce((s, r) => s + parseFloat(r.totalAmount), 0);
  const monthlyOrders = monthlySummaries.reduce((s, r) => s + r.orderCount, 0);

  return json({
    recentOrders,
    monthlyGmv,
    monthlyOrders,
    appRevenue: parseFloat((monthlyGmv * 0.01).toFixed(2)),
    isConfigured: !!settings?.bkashAppKey,
    shop,
  });
};

const STATUS_COLOR = {
  PAID: "success",
  FULFILLED: "info",
  REFUNDED: "warning",
  PARTIALLY_REFUNDED: "warning",
  CANCELLED: "critical",
};

export default function Dashboard() {
  const { recentOrders, monthlyGmv, monthlyOrders, appRevenue, isConfigured, shop } =
    useLoaderData();

  return (
    <s-page heading="Nova bKash Dashboard">
      {!isConfigured && (
        <s-banner status="warning">
          <s-paragraph>
            bKash credentials are not configured. Go to{" "}
            <s-link href="/app/settings">Settings</s-link> to set them up before payments can be accepted.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="This Month">
        <s-stack direction="inline" gap="loose">
          <s-box padding="base" borderWidth="base" borderRadius="base" style={{ flex: 1 }}>
            <s-text as="p" variant="bodyMd" tone="subdued">Total Orders</s-text>
            <s-text as="p" variant="headingXl">{monthlyOrders}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base" style={{ flex: 1 }}>
            <s-text as="p" variant="bodyMd" tone="subdued">Total GMV (BDT)</s-text>
            <s-text as="p" variant="headingXl">৳{monthlyGmv.toFixed(2)}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base" style={{ flex: 1 }}>
            <s-text as="p" variant="bodyMd" tone="subdued">App Revenue (1%)</s-text>
            <s-text as="p" variant="headingXl">৳{appRevenue.toFixed(2)}</s-text>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Recent Orders">
        {recentOrders.length === 0 ? (
          <s-paragraph>No orders yet. Orders placed through bKash will appear here.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>Order</th>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>Customer</th>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>Amount</th>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>Status</th>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>Date</th>
                <th style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}></th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((order) => (
                <tr key={order.id} style={{ borderBottom: "1px solid #f6f6f7" }}>
                  <td style={{ padding: "10px 12px" }}>
                    <s-link href={`/app/orders/${order.id}`}>{order.shopifyOrderNumber}</s-link>
                  </td>
                  <td style={{ padding: "10px 12px" }}>{order.customerName}</td>
                  <td style={{ padding: "10px 12px" }}>৳{parseFloat(order.totalAmount).toFixed(2)}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <s-badge status={STATUS_COLOR[order.status] ?? "default"}>
                      {order.status}
                    </s-badge>
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    {new Date(order.createdAt).toLocaleDateString()}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <s-link href={`https://${shop}/admin/orders/${order.shopifyOrderNumber}`} target="_blank">
                      Shopify ↗
                    </s-link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {recentOrders.length > 0 && (
          <div style={{ marginTop: "12px" }}>
            <s-link href="/app/orders">View all orders →</s-link>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error();
}

export const headers = (h) => boundary.headers(h);
