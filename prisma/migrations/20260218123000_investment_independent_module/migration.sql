-- CreateEnum
CREATE TYPE "InvestmentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvestmentProductKey" AS ENUM ('LONG_TERM', 'SHORT_TERM', 'RETIREMENT', 'LEGACY', 'CHILDREN_FUTURE');

-- CreateTable
CREATE TABLE "InvestmentProduct" (
    "id" TEXT NOT NULL,
    "key" "InvestmentProductKey" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "annualRatePct" DOUBLE PRECISION NOT NULL,
    "minMonths" INTEGER NOT NULL DEFAULT 3,
    "maxMonths" INTEGER NOT NULL DEFAULT 240,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestmentPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "InvestmentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "monthlyContribution" DOUBLE PRECISION NOT NULL,
    "durationMonths" INTEGER NOT NULL,
    "annualRatePct" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentProduct_key_key" ON "InvestmentProduct"("key");

-- CreateIndex
CREATE INDEX "InvestmentPlan_userId_createdAt_idx" ON "InvestmentPlan"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "InvestmentPlan_productId_createdAt_idx" ON "InvestmentPlan"("productId", "createdAt");

-- AddForeignKey
ALTER TABLE "InvestmentPlan" ADD CONSTRAINT "InvestmentPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentPlan" ADD CONSTRAINT "InvestmentPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "InvestmentProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

