import { json } from "react-router";
import { getPaymentStatus } from "../services/payment.service.js";
import { CORS_HEADERS, corsPrelight } from "../utils/cors.js";

export async function loader({ request, params }) {
  if (request.method === "OPTIONS") return corsPrelight();

  const { id } = params;
  if (!id) return json({ success: false, error: "Missing payment ID" }, { status: 400, headers: CORS_HEADERS });

  const status = await getPaymentStatus(id);
  if (!status) return json({ success: false, error: "Payment not found" }, { status: 404, headers: CORS_HEADERS });

  return json({ success: true, data: status }, { headers: CORS_HEADERS });
}
