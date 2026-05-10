import { useLoaderData } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";

const STATUS_COLOR = {
  PAID: "success", FULFILLED: "info", REFUNDED: "warning",
  PARTIALLY_REFUNDED: "warning", CANCELLED: "critical",
};

const REFUND_STATUS_COLOR = { COMPLETED: "success", PENDING: "warning", FAILED: "critical" };

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const order = await prisma.order.findFirst({
    where: { id: params.id, shopDomain: session.shop },
    include: {
      pendingPayment: { select: { bkashPaymentId: true, cartSnapshot: true } },
      refunds: { orderBy: { initiatedAt: "desc" } },
    },
  });

  if (!order) throw new Response("Order not found", { status: 404 });

  return ({ order, shop: session.shop });
};

export default function OrderDetail() {
  const { order, shop } = useLoaderData();
  const snap = order.pendingPayment?.cartSnapshot ?? {};
  const address = order.deliveryAddress ?? {};

  return (
    <s-page
      heading={`Order ${order.shopifyOrderNumber}`}
      back-action-url="/app/orders"
    >
      <s-button
        slot="primary-action"
        onClick={() => window.open(`https://${shop}/admin/orders/${order.shopifyOrderNumber}`, "_blank")}
      >
        View in Shopify ↗
      </s-button>

      <s-section heading="Payment">
        <table style={{ fontSize: "14px", width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {[
              ["bKash Transaction ID", order.bkashTransactionId],
              ["bKash Payment ID", order.pendingPayment?.bkashPaymentId],
              ["Total Amount", `৳${parseFloat(order.totalAmount).toFixed(2)}`],
              ["Shipping", `${order.shippingTitle} — ৳${parseFloat(order.shippingPrice).toFixed(2)}`],
              ...(order.discountCode ? [["Discount", `${order.discountCode} (-৳${parseFloat(order.discountAmount ?? 0).toFixed(2)})`]] : []),
              ["Status", order.status],
              ["Date", new Date(order.createdAt).toLocaleString()],
            ].map(([label, value]) => (
              <tr key={label} style={{ borderBottom: "1px solid #f6f6f7" }}>
                <td style={{ padding: "8px 12px", color: "#6d7175", width: "200px" }}>{label}</td>
                <td style={{ padding: "8px 12px", fontFamily: label.includes("ID") ? "monospace" : "inherit" }}>
                  {label === "Status" ? (
                    <s-badge status={STATUS_COLOR[value] ?? "default"}>{value}</s-badge>
                  ) : value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      <s-section heading="Customer">
        <table style={{ fontSize: "14px", width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {[
              ["Name", order.customerName],
              ["Phone", order.customerPhone],
              ["Email", order.customerEmail ?? "—"],
              ["Division", address.division ?? "—"],
              ["District", address.district ?? "—"],
              ["Thana", address.thana ?? "—"],
              ["Address", address.street ?? "—"],
            ].map(([label, value]) => (
              <tr key={label} style={{ borderBottom: "1px solid #f6f6f7" }}>
                <td style={{ padding: "8px 12px", color: "#6d7175", width: "200px" }}>{label}</td>
                <td style={{ padding: "8px 12px" }}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      {snap.lineItems?.length > 0 && (
        <s-section heading="Items">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                {["Product", "Qty", "Price"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snap.lineItems.map((item, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f6f6f7" }}>
                  <td style={{ padding: "10px 12px" }}>{item.title}</td>
                  <td style={{ padding: "10px 12px" }}>{item.quantity}</td>
                  <td style={{ padding: "10px 12px" }}>৳{parseFloat(item.price ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </s-section>
      )}

      {order.refunds.length > 0 && (
        <s-section heading="Refunds">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                {["Amount", "bKash Refund ID", "Status", "Date"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {order.refunds.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid #f6f6f7" }}>
                  <td style={{ padding: "10px 12px" }}>৳{parseFloat(r.refundAmount).toFixed(2)}</td>
                  <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: "12px" }}>{r.bkashRefundId ?? "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <s-badge status={REFUND_STATUS_COLOR[r.status] ?? "default"}>{r.status}</s-badge>
                  </td>
                  <td style={{ padding: "10px 12px" }}>{new Date(r.initiatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </s-section>
      )}
    </s-page>
  );
}

export function ErrorBoundary() { return boundary.error(); }
export const headers = (h) => boundary.headers(h);
