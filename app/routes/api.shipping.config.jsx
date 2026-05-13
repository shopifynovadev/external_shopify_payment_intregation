import prisma from "../db.server.js";
import { getShippingConfig } from "../services/shipping.service.js";
import { CORS_HEADERS, corsPrelight } from "../utils/cors.js";

export async function loader({ request }) {
  if (request.method === "OPTIONS") return corsPrelight();

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return Response.json(
      { success: false, error: "Missing shop parameter" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session) {
    return Response.json(
      { success: false, error: "Shop not found" },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  try {
    const config = await getShippingConfig({
      shopDomain: shop,
      accessToken: session.accessToken,
      noCache: false,
    });

    return Response.json({ success: true, data: config }, { headers: CORS_HEADERS });
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
