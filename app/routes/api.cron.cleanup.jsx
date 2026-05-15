
import prisma from "../db.server.js";

function authorized(request) {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

export async function action({ request }) {
  if (!authorized(request)) {
    return ({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const result = await prisma.paymentWithNoShopifyOrders.updateMany({
    where: {
      status: { in: ["PENDING", "AWAITING_EXECUTE"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "ABANDONED" },
  });

  return ({ success: true, data: { abandoned: result.count } });
}
