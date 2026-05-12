
import prisma from "../db.server.js";
import { validateDiscount } from "../services/discount.service.js";
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

  const { shopDomain, code, cartSubtotal } = body;

  if (!shopDomain || !code || cartSubtotal == null) {
    return corsJson({ success: false, error: "Missing required fields" }, 400);
  }

  try {
    const session = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      orderBy: { expires: "desc" },
    });

    if (!session) {
      return corsJson({ success: false, error: "Store session not found" }, 422);
    }

    const result = await validateDiscount({
      shopDomain,
      code,
      cartSubtotal: parseFloat(cartSubtotal),
      accessToken: session.accessToken,
    });

    return corsJson({ success: true, data: result });
  } catch (err) {
    return corsJson({ success: false, error: err.message }, 500);
  }
}
