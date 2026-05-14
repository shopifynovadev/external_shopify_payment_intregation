/*
  Warnings:

  - Added the required column `paidAmount` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paymentPercentage" INTEGER NOT NULL DEFAULT 100;
-- Remove the default after backfill so future rows must supply the value
ALTER TABLE "Order" ALTER COLUMN "paidAmount" SET DEFAULT 0;
