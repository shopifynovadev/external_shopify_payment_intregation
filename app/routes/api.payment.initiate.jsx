
import prisma from "../db.server.js";
import { initiatePayment } from "../services/payment.service.js";
import { corsJson, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();
  return corsJson({ success: false, error: "Method not allowed" }, 405);
}

export async function action({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();
  if (request.method !== "POST") {
    return corsJson({ success: false, error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { shopDomain, cartId, shippingHandle, discountCode, customerInfo, lineItems, subtotal } = body;

  if (!shopDomain || !cartId || !customerInfo || !lineItems || subtotal == null) {
    return corsJson({ success: false, error: "Missing required fields" }, 400);
  }

  if (!customerInfo.name || !customerInfo.phone || !customerInfo.address) {
    return corsJson({ success: false, error: "Incomplete customer info" }, 400);
  }

  try {
    const settings = await prisma.merchantSettings.findUnique({
      where: { shopDomain, isActive: true },
    });

    if (!settings?.bkashAppKey) {
      return corsJson(
        { success: false, error: "Payment not configured for this store", code: "NOT_CONFIGURED" },
        422
      );
    }

    const session = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      orderBy: { expires: "desc" },
    });

    const result = await initiatePayment({
      shopDomain,
      cartId,
      shippingHandle,
      discountCode: discountCode ?? null,
      customerInfo,
      lineItems,
      subtotal: parseFloat(subtotal),
      accessToken: session?.accessToken,
    });

    return corsJson({ success: true, data: result });
  } catch (err) {
    const code = err.code ?? "PAYMENT_INITIATE_FAILED";
    return corsJson({ success: false, error: err.message, code }, 422);
  }
}
