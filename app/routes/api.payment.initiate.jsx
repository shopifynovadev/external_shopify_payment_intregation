import prisma from "../db.server.js";
import { initiatePayment } from "../services/payment.service.js";
import { CORS_HEADERS, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();
  return Response.json({ success: false, error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();
  if (request.method !== "POST") {
    return Response.json({ success: false, error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
  }

  const { shopDomain, shippingRate, shippingSource = "db", discountCode, customerInfo, lineItems } = body;

  if (!shopDomain || !customerInfo || !lineItems?.length) {
    return Response.json({ success: false, error: "Missing required fields" }, { status: 400, headers: CORS_HEADERS });
  }

  if (!customerInfo.name || !customerInfo.phone || !customerInfo.address?.division || !customerInfo.address?.district) {
    return Response.json({ success: false, error: "Incomplete customer info" }, { status: 400, headers: CORS_HEADERS });
  }

  // DB path still requires a shipping rate code
  if (shippingSource === "db" && !shippingRate?.code) {
    return Response.json({ success: false, error: "Missing shipping rate" }, { status: 400, headers: CORS_HEADERS });
  }

  // Shopify path requires expectedTotal so we can verify against live rates
  if (shippingSource === "shopify" && shippingRate?.expectedTotal == null) {
    return Response.json({ success: false, error: "Missing expectedTotal in shippingRate" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const settings = await prisma.merchantSettings.findUnique({
      where: { shopDomain, isActive: true },
    });

    if (!settings?.bkashAppKey) {
      return Response.json(
        { success: false, error: "Payment not configured for this store", code: "NOT_CONFIGURED" },
        { status: 422, headers: CORS_HEADERS }
      );
    }

    const session = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      orderBy: { expires: "desc" },
    });

    const result = await initiatePayment({
      shopDomain,
      shippingRate,
      shippingSource,
      discountCode: discountCode ?? null,
      customerInfo,
      lineItems,
      accessToken: session?.accessToken,
    });

    return Response.json({ success: true, data: result }, { headers: CORS_HEADERS });
  } catch (err) {
    const code = err.code ?? "PAYMENT_INITIATE_FAILED";
    return Response.json({ success: false, error: err.message, code }, { status: 422, headers: CORS_HEADERS });
  }
}
