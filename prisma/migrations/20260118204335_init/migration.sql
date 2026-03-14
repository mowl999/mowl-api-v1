-- CreateEnum
CREATE TYPE "UserState" AS ENUM ('REGISTERED', 'INACTIVE', 'ACTIVE', 'ELIGIBLE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MemberType" AS ENUM ('REAL', 'VIRTUAL');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ContributionStatus" AS ENUM ('PAID', 'LATE', 'MISSED');

-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('INITIAL_DEPOSIT', 'CONTRIBUTION', 'PENALTY', 'SWAP_FEE', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "DecisionType" AS ENUM ('ELIGIBILITY_CHECK', 'POSITION_ASSIGNMENT', 'SWAP_QUOTE', 'SWAP_EXECUTE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "state" "UserState" NOT NULL DEFAULT 'INACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleConfig" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "minInitialDeposit" DOUBLE PRECISION NOT NULL,
    "creditRatePer10" DOUBLE PRECISION NOT NULL,
    "multiplierEarly" DOUBLE PRECISION NOT NULL,
    "multiplierOnTime" DOUBLE PRECISION NOT NULL,
    "multiplierLate" DOUBLE PRECISION NOT NULL,
    "eligibilityMinCredits" DOUBLE PRECISION NOT NULL,
    "eligibilityMinContributionMonths" INTEGER NOT NULL,
    "eligibilityMinPercent" DOUBLE PRECISION NOT NULL,
    "eligibilityMinTrustScore" DOUBLE PRECISION NOT NULL,
    "swapFactor" DOUBLE PRECISION NOT NULL,
    "swapDiscountRate" DOUBLE PRECISION NOT NULL,
    "maxSwapsPerPlan" INTEGER NOT NULL,
    "feeFloorAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "missedPaymentCredits" DOUBLE PRECISION NOT NULL,
    "swapAbuseCredits" DOUBLE PRECISION NOT NULL,
    "planDefaultCredits" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitialDeposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT true,
    "paymentRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InitialDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "contributionAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "status" "PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "ruleConfigId" TEXT NOT NULL,
    "assignedPosition" INTEGER NOT NULL,
    "swapsUsed" INTEGER NOT NULL DEFAULT 0,
    "currentCycleIndex" INTEGER NOT NULL DEFAULT 0,
    "feePoolAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanMember" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "type" "MemberType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "PlanMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "cycleIndex" INTEGER NOT NULL,
    "status" "ContributionStatus" NOT NULL DEFAULT 'PAID',
    "creditsAwarded" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "multiplierApplied" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "paymentRef" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "reason" "CreditReason" NOT NULL,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Penalty" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "creditsDelta" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Penalty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Swap" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromPosition" INTEGER NOT NULL,
    "toPosition" INTEGER NOT NULL,
    "steps" INTEGER NOT NULL,
    "feeCharged" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Swap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionLog" (
    "id" TEXT NOT NULL,
    "decisionType" "DecisionType" NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT,
    "inputs" JSONB NOT NULL,
    "ruleApplied" TEXT NOT NULL,
    "outcome" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RuleConfig_version_key" ON "RuleConfig"("version");

-- CreateIndex
CREATE UNIQUE INDEX "PlanMember_planId_position_key" ON "PlanMember"("planId", "position");

-- CreateIndex
CREATE INDEX "Contribution_planId_cycleIndex_idx" ON "Contribution"("planId", "cycleIndex");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Swap_planId_createdAt_idx" ON "Swap"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionLog_userId_createdAt_idx" ON "DecisionLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "InitialDeposit" ADD CONSTRAINT "InitialDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_ruleConfigId_fkey" FOREIGN KEY ("ruleConfigId") REFERENCES "RuleConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanMember" ADD CONSTRAINT "PlanMember_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Penalty" ADD CONSTRAINT "Penalty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Swap" ADD CONSTRAINT "Swap_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Swap" ADD CONSTRAINT "Swap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionLog" ADD CONSTRAINT "DecisionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionLog" ADD CONSTRAINT "DecisionLog_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
