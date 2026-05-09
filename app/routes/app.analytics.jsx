import { useLoaderData } from "react-router";
import { json } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 5);
  sixMonthsAgo.setUTCDate(1);
  sixMonthsAgo.setUTCHours(0, 0, 0, 0);

  const summaries = await prisma.orderSummary.findMany({
    where: { shopDomain: shop, date: { gte: sixMonthsAgo } },
    orderBy: { date: "asc" },
  });

  // Group by month
  const byMonth = {};
  for (const row of summaries) {
    const d = new Date(row.date);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = { month: key, gmv: 0, orders: 0, revenue: 0 };
    byMonth[key].gmv += parseFloat(row.totalAmount);
    byMonth[key].orders += row.orderCount;
  }

  // Fill in missing months
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("default", { month: "short", year: "2-digit" });
    const data = byMonth[key] ?? { gmv: 0, orders: 0 };
    months.push({ label, gmv: parseFloat(data.gmv.toFixed(2)), orders: data.orders, revenue: parseFloat((data.gmv * 0.01).toFixed(2)) });
  }

  const totalGmv = months.reduce((s, m) => s + m.gmv, 0);
  const totalOrders = months.reduce((s, m) => s + m.orders, 0);
  const totalRevenue = parseFloat((totalGmv * 0.01).toFixed(2));

  return json({ months, totalGmv, totalOrders, totalRevenue });
};

export default function Analytics() {
  const { months, totalGmv, totalOrders, totalRevenue } = useLoaderData();

  return (
    <s-page heading="Revenue Analytics">
      <s-section heading="Last 6 Months Summary">
        <s-stack direction="inline" gap="loose">
          <s-box padding="base" borderWidth="base" borderRadius="base" style={{ flex: 1 }}>
            <s-text as="p" variant="bodyMd" tone="subdued">Total GMV</s-text>
            <s-text as="p" variant="headingXl">৳{totalGmv.toFixed(2)}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base" style={{ flex: 1 }}>
            <s-text as="p" variant="bodyMd" tone="subdued">Total Orders</s-text>
            <s-text as="p" variant="headingXl">{totalOrders}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base" style={{ flex: 1 }}>
            <s-text as="p" variant="bodyMd" tone="subdued">App Revenue (1%)</s-text>
            <s-text as="p" variant="headingXl">৳{totalRevenue.toFixed(2)}</s-text>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Monthly GMV (BDT)">
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={months} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => [`৳${v.toFixed(2)}`, "GMV"]} />
              <Legend />
              <Line type="monotone" dataKey="gmv" stroke="#E2136E" strokeWidth={2} dot={{ r: 4 }} name="GMV (BDT)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </s-section>

      <s-section heading="Monthly Orders">
        <div style={{ width: "100%", height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={months} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => [v, "Orders"]} />
              <Bar dataKey="orders" fill="#E2136E" name="Orders" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() { return boundary.error(); }
export const headers = (h) => boundary.headers(h);
