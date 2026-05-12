
import prisma from "../db.server.js";
import { corsJson, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return corsJson({ success: false, error: "Missing shop" }, 400);
  }

  const settings = await prisma.merchantSettings.findUnique({
    where: { shopDomain: shop, isActive: true },
    select: { storefrontAccessToken: true, bkashAppKey: true },
  });

  if (!settings?.storefrontAccessToken) {
    return corsJson({ success: false, error: "Not configured" }, 404);
  }

  return corsJson({
    success: true,
    data: {
      storefrontToken: settings.storefrontAccessToken,
      appUrl: process.env.SHOPIFY_APP_URL,
      isPaymentConfigured: !!settings.bkashAppKey,
    },
  });
}
