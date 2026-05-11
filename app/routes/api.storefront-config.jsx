
import prisma from "../db.server.js";
import { CORS_HEADERS, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return Response.json({ success: false, error: "Missing shop" }, { status: 400, headers: CORS_HEADERS });
  }

  const settings = await prisma.merchantSettings.findUnique({
    where: { shopDomain: shop, isActive: true },
    select: { bkashAppKey: true },
  });

  if (!settings) {
    return Response.json({ success: false, error: "Store not found" }, { status: 404, headers: CORS_HEADERS });
  }

  return Response.json(
    {
      success: true,
      data: {
        appUrl: process.env.SHOPIFY_APP_URL,
        isPaymentConfigured: !!settings.bkashAppKey,
      },
    },
    { headers: CORS_HEADERS }
  );
}
