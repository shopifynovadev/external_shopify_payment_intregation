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

  const { shopDomain, shippingRate, discountCode, customerInfo, lineItems, paymentPercentage } = body;

  if (!shopDomain || !customerInfo || !lineItems?.length) {
    return Response.json({ success: false, error: "Missing required fields" }, { status: 400, headers: CORS_HEADERS });
  }

  if (!/^[a-zA-Z0-9-]+\.myshopify\.com$/.test(shopDomain)) {
    return Response.json({ success: false, error: "Invalid shop domain" }, { status: 400, headers: CORS_HEADERS });
  }

  if (!customerInfo.name || !customerInfo.phone || !customerInfo.address?.division || !customerInfo.address?.district) {
    return Response.json({ success: false, error: "Incomplete customer info" }, { status: 400, headers: CORS_HEADERS });
  }

  const BD_PHONE_RE = /^(\+?8801|01)[0-9]{9}$/;
  if (!BD_PHONE_RE.test(customerInfo.phone)) {
    return Response.json({ success: false, error: "Invalid phone number format" }, { status: 400, headers: CORS_HEADERS });
  }

  if (customerInfo.name.length > 100) {
    return Response.json({ success: false, error: "Name too long (max 100 characters)" }, { status: 400, headers: CORS_HEADERS });
  }
  if ((customerInfo.address.street ?? "").length > 200) {
    return Response.json({ success: false, error: "Street address too long (max 200 characters)" }, { status: 400, headers: CORS_HEADERS });
  }
  if (discountCode && discountCode.length > 50) {
    return Response.json({ success: false, error: "Discount code too long (max 50 characters)" }, { status: 400, headers: CORS_HEADERS });
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

    if (!session?.accessToken) {
      return Response.json(
        { success: false, error: "Store session not found. Please reinstall the app.", code: "NO_SESSION" },
        { status: 422, headers: CORS_HEADERS }
      );
    }

    const result = await initiatePayment({
      shopDomain,
      shippingRate,
      discountCode: discountCode ?? null,
      customerInfo,
      lineItems,
      paymentPercentage: paymentPercentage ?? 100,
      accessToken: session.accessToken,
    });

    return Response.json({ success: true, data: result }, { headers: CORS_HEADERS });
  } catch (err) {
    const code = err.code ?? "PAYMENT_INITIATE_FAILED";
    return Response.json({ success: false, error: err.message, code }, { status: 422, headers: CORS_HEADERS });
  }
}
