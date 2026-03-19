-- Add equity requirement settings directly on each loan product
ALTER TABLE "LoanProduct"
  ADD COLUMN "equityRequirementPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "minimumEquityAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Confirmed equity contributions credited to the borrower application wallet
CREATE TABLE "LoanEquityContribution" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'GBP',
  "channel" "PaymentChannel" NOT NULL,
  "paymentRef" TEXT,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanEquityContribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoanEquityContribution_applicationId_createdAt_idx"
  ON "LoanEquityContribution"("applicationId", "createdAt");
CREATE INDEX "LoanEquityContribution_userId_createdAt_idx"
  ON "LoanEquityContribution"("userId", "createdAt");

ALTER TABLE "LoanEquityContribution"
  ADD CONSTRAINT "LoanEquityContribution_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LoanEquityContribution"
  ADD CONSTRAINT "LoanEquityContribution_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Payment submissions for loan equity, including manual transfers that await admin review
CREATE TABLE "LoanEquityPayment" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'GBP',
  "channel" "PaymentChannel" NOT NULL,
  "status" "PaymentSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
  "providerRef" TEXT,
  "userReference" TEXT,
  "receiptUrl" TEXT,
  "note" TEXT,
  "reviewedById" TEXT,
  "reviewNote" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanEquityPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoanEquityPayment_status_submittedAt_idx"
  ON "LoanEquityPayment"("status", "submittedAt");
CREATE INDEX "LoanEquityPayment_applicationId_submittedAt_idx"
  ON "LoanEquityPayment"("applicationId", "submittedAt");
CREATE INDEX "LoanEquityPayment_userId_submittedAt_idx"
  ON "LoanEquityPayment"("userId", "submittedAt");

ALTER TABLE "LoanEquityPayment"
  ADD CONSTRAINT "LoanEquityPayment_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LoanEquityPayment"
  ADD CONSTRAINT "LoanEquityPayment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
