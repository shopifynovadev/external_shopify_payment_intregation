import { useLoaderData, useSearchParams } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";

const PAGE_SIZE = 20;

const STATUS_COLOR = {
  PAID: "success",
  FULFILLED: "info",
  REFUNDED: "warning",
  PARTIALLY_REFUNDED: "warning",
  CANCELLED: "critical",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") ?? "1");
  const status = url.searchParams.get("status") ?? "";
  const search = url.searchParams.get("search") ?? "";
  const tab = url.searchParams.get("tab") ?? "orders";

  if (tab === "issues") {
    const issueWhere = {
      shopDomain: shop,
      status: "ORDER_FAILED",
      ...(search
        ? {
            OR: [
              { customerInfo: { path: ["phone"], string_contains: search } },
              { customerInfo: { path: ["name"], string_contains: search } },
            ],
          }
        : {}),
    };

    const [issues, total] = await Promise.all([
      prisma.paymentWithNoShopifyOrders.findMany({
        where: issueWhere,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          customerInfo: true,
          totalAmount: true,
          cartSnapshot: true,
          bkashExecuteResponse: true,
          errorDetails: true,
          createdAt: true,
        },
      }),
      prisma.paymentWithNoShopifyOrders.count({ where: issueWhere }),
    ]);

    return { tab: "issues", issues, total, page, pageSize: PAGE_SIZE, shop };
  }

  const where = {
    shopDomain: shop,
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { shopifyOrderNumber: { contains: search, mode: "insensitive" } },
            { customerName: { contains: search, mode: "insensitive" } },
            { bkashTransactionId: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [orders, total, issueCount] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        shopifyOrderNumber: true,
        customerName: true,
        customerPhone: true,
        totalAmount: true,
        status: true,
        bkashTransactionId: true,
        createdAt: true,
      },
    }),
    prisma.order.count({ where }),
    prisma.paymentWithNoShopifyOrders.count({ where: { shopDomain: shop, status: "ORDER_FAILED" } }),
  ]);

  return { tab: "orders", orders, total, page, pageSize: PAGE_SIZE, shop, issueCount };
};

export default function Orders() {
  const data = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = data.tab;
  const total = data.total;
  const page = data.page;
  const pageSize = data.pageSize;
  const shop = data.shop;
  const totalPages = Math.ceil(total / pageSize);

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    setSearchParams(next);
  };

  const switchTab = (t) => {
    const next = new URLSearchParams();
    next.set("tab", t);
    setSearchParams(next);
  };

  return (
    <s-page heading="Orders">
      <s-section>
        {/* Tab switcher */}
        <s-stack direction="inline" gap="base" style={{ marginBottom: "16px" }}>
          <s-button
            variant={tab === "orders" ? "primary" : "secondary"}
            onClick={() => switchTab("orders")}
          >
            Orders
          </s-button>
          <s-button
            variant={tab === "issues" ? "primary" : "secondary"}
            onClick={() => switchTab("issues")}
          >
            Payment Issues {data.issueCount > 0 && `(${data.issueCount})`}
          </s-button>
        </s-stack>

        {/* Search + filter row */}
        <s-stack direction="inline" gap="base">
          <input
            type="text"
            placeholder={tab === "issues" ? "Search customer name or phone..." : "Search order#, customer, txn ID..."}
            defaultValue={searchParams.get("search") ?? ""}
            onChange={(e) => setParam("search", e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: "6px", flex: 1 }}
          />
          {tab === "orders" && (
            <select
              value={searchParams.get("status") ?? ""}
              onChange={(e) => setParam("status", e.target.value)}
              style={{ padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: "6px" }}
            >
              <option value="">All statuses</option>
              <option value="PAID">Paid</option>
              <option value="FULFILLED">Fulfilled</option>
              <option value="REFUNDED">Refunded</option>
              <option value="PARTIALLY_REFUNDED">Partially Refunded</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          )}
        </s-stack>

        <div style={{ marginTop: "16px" }}>
          <s-text tone="subdued">{total} {tab === "issues" ? "issue" : "order"}{total !== 1 ? "s" : ""} found</s-text>
        </div>

        {/* Orders table */}
        {tab === "orders" && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", marginTop: "12px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                {["Order", "Customer", "Phone", "Amount", "bKash TxnID", "Status", "Date", ""].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.orders.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: "24px", textAlign: "center", color: "#6d7175" }}>No orders found</td>
                </tr>
              ) : data.orders.map((order) => (
                <tr key={order.id} style={{ borderBottom: "1px solid #f6f6f7" }}>
                  <td style={{ padding: "10px 12px" }}>
                    <s-link href={`/app/orders/${order.id}`}>{order.shopifyOrderNumber}</s-link>
                  </td>
                  <td style={{ padding: "10px 12px" }}>{order.customerName}</td>
                  <td style={{ padding: "10px 12px" }}>{order.customerPhone}</td>
                  <td style={{ padding: "10px 12px" }}>৳{parseFloat(order.totalAmount).toFixed(2)}</td>
                  <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: "12px" }}>
                    {order.bkashTransactionId}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <s-badge status={STATUS_COLOR[order.status] ?? "default"}>{order.status}</s-badge>
                  </td>
                  <td style={{ padding: "10px 12px" }}>{new Date(order.createdAt).toLocaleDateString()}</td>
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

        {/* Payment Issues table */}
        {tab === "issues" && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", marginTop: "12px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                {["Customer", "Phone", "Amount Paid", "bKash TxnID", "Error", "Date"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.issues.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: "24px", textAlign: "center", color: "#6d7175" }}>No payment issues found</td>
                </tr>
              ) : data.issues.map((issue) => {
                const customer = issue.customerInfo ?? {};
                const snap = issue.cartSnapshot ?? {};
                const trxID = issue.bkashExecuteResponse?.trxID ?? "—";
                const paid = snap.chargedAmount ?? snap.total ?? issue.totalAmount;
                return (
                  <tr key={issue.id} style={{ borderBottom: "1px solid #f6f6f7", background: "#fff4f4" }}>
                    <td style={{ padding: "10px 12px" }}>{customer.name ?? "—"}</td>
                    <td style={{ padding: "10px 12px" }}>{customer.phone ?? "—"}</td>
                    <td style={{ padding: "10px 12px" }}>৳{parseFloat(paid).toFixed(2)}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: "12px" }}>{trxID}</td>
                    <td style={{ padding: "10px 12px", color: "#d72c0d", fontSize: "12px" }}>
                      {issue.errorDetails ?? "Unknown error"}
                    </td>
                    <td style={{ padding: "10px 12px" }}>{new Date(issue.createdAt).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {totalPages > 1 && (
          <s-stack direction="inline" gap="base" style={{ marginTop: "16px", justifyContent: "center" }}>
            <s-button disabled={page <= 1} onClick={() => setParam("page", String(page - 1))}>Previous</s-button>
            <s-text>Page {page} of {totalPages}</s-text>
            <s-button disabled={page >= totalPages} onClick={() => setParam("page", String(page + 1))}>Next</s-button>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() { return boundary.error(); }
export const headers = (h) => boundary.headers(h);
