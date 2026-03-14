-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LoanTransactionType" AS ENUM ('DISBURSEMENT', 'REPAYMENT', 'INTEREST_CHARGE', 'FEE', 'WAIVER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "FundTransferTransactionType" AS ENUM ('REMITTANCE_OUT', 'REMITTANCE_IN', 'SETTLEMENT', 'FX_FEE', 'TRANSFER_FEE', 'REFUND', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "LoanTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LoanTransactionType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "reference" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundTransferTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "FundTransferTransactionType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "reference" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundTransferTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanTransaction_userId_createdAt_idx" ON "LoanTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FundTransferTransaction_userId_createdAt_idx" ON "FundTransferTransaction"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "LoanTransaction" ADD CONSTRAINT "LoanTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundTransferTransaction" ADD CONSTRAINT "FundTransferTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

