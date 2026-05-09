import { authenticate } from "../shopify.server.js";
import { handleRefundWebhook } from "../services/refund.service.js";

export async function action({ request }) {
  const { topic, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_REFUNDED") {
    return new Response(null, { status: 200 });
  }

  const shopifyOrderId = payload.admin_graphql_api_id;
  const refundData = payload.refunds?.[0];

  if (!refundData) return new Response(null, { status: 200 });

  const shopifyRefundId = refundData.admin_graphql_api_id;
  const refundAmount = parseFloat(refundData.transactions?.[0]?.amount ?? 0);
  const reason = refundData.note ?? null;

  // Idempotency handled inside — returns 200 in all cases so Shopify stops retrying
  await handleRefundWebhook({ shopifyRefundId, shopifyOrderId, refundAmount, reason });

  return new Response(null, { status: 200 });
}
