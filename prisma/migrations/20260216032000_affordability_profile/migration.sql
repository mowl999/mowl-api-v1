-- AlterTable
ALTER TABLE "public"."User"
ADD COLUMN "monthlyIncome" DOUBLE PRECISION,
ADD COLUMN "monthlyExpenses" DOUBLE PRECISION,
ADD COLUMN "otherMonthlyEarnings" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."RuleConfig"
ADD COLUMN "maxDisposableCommitmentPct" DOUBLE PRECISION NOT NULL DEFAULT 0.6;
