import { getApplicableRates } from "../models/shippingRate.server.js";
import { corsJson, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const division = url.searchParams.get("division");
  const orderTotal = url.searchParams.get("total") ?? "0";

  if (!shop || !division) {
    return corsJson({ success: false, error: "Missing shop or division" }, 400);
  }

  const rates = await getApplicableRates({ shopDomain: shop, division, orderTotal });

  return corsJson({ success: true, data: rates });
}
