import { useLoaderData } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server.js";

const STATUS_COLOR = { UNPAID: "warning", PAID: "success", WAIVED: "info" };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const invoices = await prisma.invoice.findMany({
    where: { shopDomain: session.shop },
    orderBy: { periodStart: "desc" },
  });

  return ({ invoices });
};

export default function Billing() {
  const { invoices } = useLoaderData();

  return (
    <s-page heading="Billing & Invoices">
      <s-section>
        <s-paragraph>
          Nova bKash charges 1% of your monthly GMV (total order value processed through bKash).
          Invoices are generated on the 1st of each month for the previous month.
        </s-paragraph>
      </s-section>

      <s-section heading="Invoice History">
        {invoices.length === 0 ? (
          <s-paragraph>No invoices yet. Your first invoice will be generated on the 1st of next month.</s-paragraph>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                {["Period", "GMV", "Invoice Amount (1%)", "Type", "Status", "Generated"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#6d7175" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} style={{ borderBottom: "1px solid #f6f6f7" }}>
                  <td style={{ padding: "10px 12px" }}>
                    {new Date(inv.periodStart).toLocaleDateString()} – {new Date(inv.periodEnd).toLocaleDateString()}
                  </td>
                  <td style={{ padding: "10px 12px" }}>৳{parseFloat(inv.gmvTotal).toFixed(2)}</td>
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>৳{parseFloat(inv.invoiceAmount).toFixed(2)}</td>
                  <td style={{ padding: "10px 12px" }}>
                    {inv.isProratedFirst ? <s-badge status="info">Pro-rated</s-badge> : "Full month"}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <s-badge status={STATUS_COLOR[inv.status] ?? "default"}>{inv.status}</s-badge>
                  </td>
                  <td style={{ padding: "10px 12px" }}>{new Date(inv.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() { return boundary.error(); }
export const headers = (h) => boundary.headers(h);
