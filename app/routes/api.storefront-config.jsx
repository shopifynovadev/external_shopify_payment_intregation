import { json } from "react-router";
import prisma from "../db.server.js";
import { CORS_HEADERS, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return json({ success: false, error: "Missing shop" }, { status: 400, headers: CORS_HEADERS });
  }

  const settings = await prisma.merchantSettings.findUnique({
    where: { shopDomain: shop, isActive: true },
    select: { storefrontAccessToken: true, bkashAppKey: true },
  });

  if (!settings?.storefrontAccessToken) {
    return json({ success: false, error: "Not configured" }, { status: 404, headers: CORS_HEADERS });
  }

  return json(
    {
      success: true,
      data: {
        storefrontToken: settings.storefrontAccessToken,
        appUrl: process.env.SHOPIFY_APP_URL,
        isPaymentConfigured: !!settings.bkashAppKey,
      },
    },
    { headers: CORS_HEADERS }
  );
}
