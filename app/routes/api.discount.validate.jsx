
import prisma from "../db.server.js";
import { validateDiscount } from "../services/discount.service.js";
import { CORS_HEADERS, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();
  return ({ success: false, error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();
  if (request.method !== "POST") {
    return ({ success: false, error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return ({ success: false, error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
  }

  const { shopDomain, code, cartSubtotal } = body;

  if (!shopDomain || !code || cartSubtotal == null) {
    return ({ success: false, error: "Missing required fields" }, { status: 400, headers: CORS_HEADERS });
  }

  try {
    const session = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      orderBy: { expires: "desc" },
    });

    if (!session) {
      return ({ success: false, error: "Store session not found" }, { status: 422, headers: CORS_HEADERS });
    }

    const result = await validateDiscount({
      shopDomain,
      code,
      cartSubtotal: parseFloat(cartSubtotal),
      accessToken: session.accessToken,
    });

    return ({ success: true, data: result }, { headers: CORS_HEADERS });
  } catch (err) {
    return ({ success: false, error: err.message }, { status: 500, headers: CORS_HEADERS });
  }
}
