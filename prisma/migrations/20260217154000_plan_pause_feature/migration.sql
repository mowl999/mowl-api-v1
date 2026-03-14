ALTER TYPE "public"."ContributionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';

CREATE TYPE "public"."PlanPauseStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');

ALTER TABLE "public"."RuleConfig"
ADD COLUMN "pauseFeatureEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "pauseFeePerMonth" DOUBLE PRECISION NOT NULL DEFAULT 50,
ADD COLUMN "maxPauseMonths" INTEGER NOT NULL DEFAULT 2;

CREATE TABLE "public"."PlanPause" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "startCycleIndex" INTEGER NOT NULL,
  "endCycleIndex" INTEGER NOT NULL,
  "months" INTEGER NOT NULL,
  "feePerMonth" DOUBLE PRECISION NOT NULL,
  "totalFee" DOUBLE PRECISION NOT NULL,
  "status" "public"."PlanPauseStatus" NOT NULL DEFAULT 'SUBMITTED',
  "paymentRef" TEXT,
  "note" TEXT,
  "reviewedById" TEXT,
  "reviewNote" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlanPause_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlanPause_planId_createdAt_idx" ON "public"."PlanPause"("planId", "createdAt");
CREATE INDEX "PlanPause_userId_createdAt_idx" ON "public"."PlanPause"("userId", "createdAt");
CREATE INDEX "PlanPause_status_createdAt_idx" ON "public"."PlanPause"("status", "createdAt");

ALTER TABLE "public"."PlanPause" ADD CONSTRAINT "PlanPause_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "public"."Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."PlanPause" ADD CONSTRAINT "PlanPause_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
