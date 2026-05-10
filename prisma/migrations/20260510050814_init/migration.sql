-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AWAITING_EXECUTE', 'COMPLETED', 'FAILED', 'ABANDONED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PAID', 'FULFILLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PAID', 'WAIVED');

-- CreateTable
CREATE TABLE "MerchantSettings" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "bkashNumber" TEXT,
    "bkashUsername" TEXT,
    "bkashPassword" TEXT,
    "bkashAppKey" TEXT,
    "bkashAppSecret" TEXT,
    "bkashApiBaseUrl" TEXT,
    "storefrontAccessToken" TEXT,
    "enabledThemes" TEXT[],
    "hideCheckout" BOOLEAN NOT NULL DEFAULT true,
    "billingStartDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingPayment" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "bkashPaymentId" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "cartSnapshot" JSONB NOT NULL,
    "customerInfo" JSONB NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "bkashExecuteResponse" JSONB,
    "errorDetails" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT NOT NULL,
    "shopifyDraftOrderId" TEXT,
    "pendingPaymentId" TEXT NOT NULL,
    "bkashTransactionId" TEXT NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "status" "OrderStatus" NOT NULL DEFAULT 'PAID',
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "deliveryAddress" JSONB NOT NULL,
    "shippingTitle" TEXT NOT NULL,
    "shippingPrice" DECIMAL(10,2) NOT NULL,
    "discountCode" TEXT,
    "discountAmount" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderSummary" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyRefundId" TEXT NOT NULL,
    "bkashRefundId" TEXT,
    "bkashTransactionId" TEXT NOT NULL,
    "refundAmount" DECIMAL(12,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "errorDetails" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "gmvTotal" DECIMAL(14,2) NOT NULL,
    "invoiceAmount" DECIMAL(12,2) NOT NULL,
    "isProratedFirst" BOOLEAN NOT NULL DEFAULT false,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpRequest" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "lockedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSettings_shopDomain_key" ON "MerchantSettings"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPayment_idempotencyKey_key" ON "PendingPayment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPayment_bkashPaymentId_key" ON "PendingPayment"("bkashPaymentId");

-- CreateIndex
CREATE INDEX "PendingPayment_shopDomain_idx" ON "PendingPayment"("shopDomain");

-- CreateIndex
CREATE INDEX "PendingPayment_status_expiresAt_idx" ON "PendingPayment"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopifyOrderId_key" ON "Order"("shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_pendingPaymentId_key" ON "Order"("pendingPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_bkashTransactionId_key" ON "Order"("bkashTransactionId");

-- CreateIndex
CREATE INDEX "Order_shopDomain_idx" ON "Order"("shopDomain");

-- CreateIndex
CREATE INDEX "Order_shopDomain_createdAt_idx" ON "Order"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "OrderSummary_shopDomain_date_idx" ON "OrderSummary"("shopDomain", "date");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSummary_shopDomain_date_key" ON "OrderSummary"("shopDomain", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_shopifyRefundId_key" ON "Refund"("shopifyRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_bkashRefundId_key" ON "Refund"("bkashRefundId");

-- CreateIndex
CREATE INDEX "Refund_shopDomain_idx" ON "Refund"("shopDomain");

-- CreateIndex
CREATE INDEX "Invoice_shopDomain_idx" ON "Invoice"("shopDomain");

-- CreateIndex
CREATE INDEX "OtpRequest_shopDomain_purpose_idx" ON "OtpRequest"("shopDomain", "purpose");

-- CreateIndex
CREATE INDEX "AuditLog_shopDomain_createdAt_idx" ON "AuditLog"("shopDomain", "createdAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_pendingPaymentId_fkey" FOREIGN KEY ("pendingPaymentId") REFERENCES "PendingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "MerchantSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSummary" ADD CONSTRAINT "OrderSummary_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "MerchantSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "MerchantSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpRequest" ADD CONSTRAINT "OtpRequest_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "MerchantSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "MerchantSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;
