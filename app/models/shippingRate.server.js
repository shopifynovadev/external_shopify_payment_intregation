import prisma from "../db.server.js";

export async function getShippingRates({ shopDomain, page = 1, pageSize = 20 }) {
  const where = { shopDomain };
  const [rates, total] = await Promise.all([
    prisma.shippingRate.findMany({
      where,
      orderBy: [{ division: "asc" }, { createdAt: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.shippingRate.count({ where }),
  ]);
  return { rates, total };
}

export async function createShippingRate({ shopDomain, title, division, flatAmount, freeAbove, estimatedDays }) {
  return prisma.shippingRate.create({
    data: {
      shopDomain,
      title,
      division,
      flatAmount: parseFloat(flatAmount),
      freeAbove: freeAbove ? parseFloat(freeAbove) : null,
      estimatedDays: estimatedDays || null,
      isActive: true,
    },
  });
}

export async function updateShippingRate({ id, shopDomain, title, division, flatAmount, freeAbove, estimatedDays, isActive }) {
  return prisma.shippingRate.updateMany({
    where: { id, shopDomain },
    data: {
      title,
      division,
      flatAmount: parseFloat(flatAmount),
      freeAbove: freeAbove ? parseFloat(freeAbove) : null,
      estimatedDays: estimatedDays || null,
      isActive: isActive === true || isActive === "true",
    },
  });
}

export async function deleteShippingRate({ id, shopDomain }) {
  return prisma.shippingRate.deleteMany({ where: { id, shopDomain } });
}

// Used by payment service — returns the rate from DB and applies free shipping logic
export async function resolveShippingRate({ id, shopDomain, orderTotal }) {
  const rate = await prisma.shippingRate.findFirst({
    where: { id, shopDomain, isActive: true },
  });

  if (!rate) return null;

  const isFree = rate.freeAbove != null && parseFloat(orderTotal) >= parseFloat(rate.freeAbove);

  return {
    id: rate.id,
    title: rate.title,
    division: rate.division,
    price: isFree ? 0 : parseFloat(rate.flatAmount),
    estimatedDays: rate.estimatedDays,
  };
}

// Used by cart block API — returns all applicable rates for a division
export async function getApplicableRates({ shopDomain, division, orderTotal }) {
  const rates = await prisma.shippingRate.findMany({
    where: {
      shopDomain,
      isActive: true,
      division: { in: [division, "ALL"] },
    },
    orderBy: [
      // Division-specific rates first, then ALL fallback
      { division: "desc" },
      { flatAmount: "asc" },
    ],
  });

  return rates.map((rate) => {
    const isFree = rate.freeAbove != null && parseFloat(orderTotal ?? 0) >= parseFloat(rate.freeAbove);
    return {
      id: rate.id,
      title: rate.title,
      division: rate.division,
      price: isFree ? 0 : parseFloat(rate.flatAmount),
      originalPrice: parseFloat(rate.flatAmount),
      isFree,
      estimatedDays: rate.estimatedDays,
    };
  });
}
