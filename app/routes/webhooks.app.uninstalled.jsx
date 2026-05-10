import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session } = await authenticate.webhook(request);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Deactivate merchant — preserve all historical orders/invoices/refunds
  await db.merchantSettings.updateMany({
    where: { shopDomain: shop },
    data: { isActive: false },
  });

  await db.auditLog.create({
    data: {
      shopDomain: shop,
      action: "APP_UNINSTALLED",
      actor: shop,
      metadata: { hadSession: !!session },
    },
  }).catch(() => {}); // non-critical, best effort

  return new Response(null, { status: 200 });
};
