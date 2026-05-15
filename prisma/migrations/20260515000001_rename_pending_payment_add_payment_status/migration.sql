-- Rename PendingPayment table to PaymentWithNoShopifyOrders
ALTER TABLE "PendingPayment" RENAME TO "PaymentWithNoShopifyOrders";

-- Add paidAmount (nullable — set after bKash execute succeeds)
ALTER TABLE "PaymentWithNoShopifyOrders"
  ADD COLUMN "paidAmount" DECIMAL(12,2),
  ADD COLUMN "paymentPercentage" INTEGER NOT NULL DEFAULT 100;

-- Add ShopifyPaymentStatus enum
CREATE TYPE "ShopifyPaymentStatus" AS ENUM ('PAID', 'PARTIALLY_PAID', 'UNPAID');

-- Add shopifyPaymentStatus to Order (default UNPAID for existing rows)
ALTER TABLE "Order"
  ADD COLUMN "shopifyPaymentStatus" "ShopifyPaymentStatus" NOT NULL DEFAULT 'UNPAID';
