
import prisma from "../db.server.js";
import { billingQueue } from "../queues/index.js";

function authorized(request) {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

async function generateInvoiceForMerchant(merchant) {
  const now = new Date();
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const prevMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59));

  // Don't bill if merchant installed this month (not enough history yet)
  if (merchant.billingStartDate >= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))) {
    return null;
  }

  // Idempotency — skip if invoice already exists for this period
  const existingInvoice = await prisma.invoice.findFirst({
    where: { shopDomain: merchant.shopDomain, periodStart: prevMonthStart },
  });
  if (existingInvoice) return null;

  // Pro-rate: if installed mid-previous-month, start from install date
  const isProratedFirst = merchant.billingStartDate > prevMonthStart;
  const periodStart = isProratedFirst ? merchant.billingStartDate : prevMonthStart;

  const summaries = await prisma.orderSummary.findMany({
    where: {
      shopDomain: merchant.shopDomain,
      date: { gte: periodStart, lte: prevMonthEnd },
    },
  });

  const gmvTotal = summaries.reduce((sum, s) => sum + parseFloat(s.totalAmount), 0);
  const invoiceAmount = parseFloat((gmvTotal * 0.01).toFixed(2));

  const invoice = await prisma.invoice.create({
    data: {
      shopDomain: merchant.shopDomain,
      periodStart,
      periodEnd: prevMonthEnd,
      gmvTotal,
      invoiceAmount,
      isProratedFirst,
      status: "UNPAID",
    },
  });

  await prisma.auditLog.create({
    data: {
      shopDomain: merchant.shopDomain,
      action: "INVOICE_GENERATED",
      actor: "SYSTEM",
      metadata: { invoiceId: invoice.id, gmvTotal, invoiceAmount, isProratedFirst },
    },
  });

  return invoice;
}

export async function action({ request }) {
  if (!authorized(request)) {
    return ({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const merchants = await prisma.merchantSettings.findMany({ where: { isActive: true } });

  const results = await Promise.allSettled(
    merchants.map((merchant) =>
      billingQueue.enqueue(() => generateInvoiceForMerchant(merchant))
    )
  );

  const created = results.filter((r) => r.status === "fulfilled" && r.value).length;
  const skipped = results.filter((r) => r.status === "fulfilled" && !r.value).length;
  const failed = results.filter((r) => r.status === "rejected").length;

  return ({ success: true, data: { total: merchants.length, created, skipped, failed } });
}
