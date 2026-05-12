-- CreateTable
CREATE TABLE "ShippingRate" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "flatAmount" DECIMAL(10,2) NOT NULL,
    "freeAbove" DECIMAL(10,2),
    "estimatedDays" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShippingRate_shopDomain_isActive_idx" ON "ShippingRate"("shopDomain", "isActive");

-- CreateIndex
CREATE INDEX "ShippingRate_shopDomain_division_isActive_idx" ON "ShippingRate"("shopDomain", "division", "isActive");
