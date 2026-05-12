
import { getPaymentStatus } from "../services/payment.service.js";
import { corsJson, corsPrelight } from "../utils/cors.js";

export async function loader({ request, params }) {
  if (request.method === "OPTIONS") return corsPrelight();

  const { id } = params;
  if (!id) return corsJson({ success: false, error: "Missing payment ID" }, 400);

  const status = await getPaymentStatus(id);
  if (!status) return corsJson({ success: false, data: null, error: "Payment not found" }, 404);

  return corsJson({ success: true, data: status });
}
