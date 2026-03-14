-- CreateEnum
CREATE TYPE "public"."PaymentChannel" AS ENUM ('GATEWAY', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "public"."PaymentSubmissionStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "public"."ContributionPayment" (
    "id" TEXT NOT NULL,
    "contributionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "channel" "public"."PaymentChannel" NOT NULL,
    "status" "public"."PaymentSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "providerRef" TEXT,
    "userReference" TEXT,
    "receiptUrl" TEXT,
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContributionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContributionPayment_status_submittedAt_idx" ON "public"."ContributionPayment"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "ContributionPayment_userId_submittedAt_idx" ON "public"."ContributionPayment"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "ContributionPayment_planId_submittedAt_idx" ON "public"."ContributionPayment"("planId", "submittedAt");

-- CreateIndex
CREATE INDEX "ContributionPayment_contributionId_submittedAt_idx" ON "public"."ContributionPayment"("contributionId", "submittedAt");

-- AddForeignKey
ALTER TABLE "public"."ContributionPayment" ADD CONSTRAINT "ContributionPayment_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "public"."Contribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContributionPayment" ADD CONSTRAINT "ContributionPayment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContributionPayment" ADD CONSTRAINT "ContributionPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
