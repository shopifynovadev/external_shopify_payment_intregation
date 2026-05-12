
import prisma from "../db.server.js";

function authorized(request) {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

export async function action({ request }) {
  if (!authorized(request)) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const result = await prisma.pendingPayment.updateMany({
    where: {
      status: { in: ["PENDING", "AWAITING_EXECUTE"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "ABANDONED" },
  });

  return ({ success: true, data: { abandoned: result.count } });
}
