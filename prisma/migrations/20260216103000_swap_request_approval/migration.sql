-- CreateEnum
CREATE TYPE "SwapRequestStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Swap"
  ADD COLUMN "status" "SwapRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- Indexes
CREATE INDEX "Swap_status_createdAt_idx" ON "Swap"("status", "createdAt");
