import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";

export async function action({ request }) {
  const { payload } = await authenticate.webhook(request);

  const shopifyOrderId = payload.admin_graphql_api_id;

  const order = await prisma.order.findUnique({ where: { shopifyOrderId } });
  if (!order) return new Response(null, { status: 200 });

  await prisma.order.update({
    where: { id: order.id },
    data: { status: "FULFILLED" },
  });

  return new Response(null, { status: 200 });
}
