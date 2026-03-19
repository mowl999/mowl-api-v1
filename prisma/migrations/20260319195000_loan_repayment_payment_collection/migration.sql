CREATE TABLE "LoanRepaymentPayment" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "installmentId" TEXT NOT NULL,
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

  CONSTRAINT "LoanRepaymentPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoanRepaymentPayment_status_submittedAt_idx" ON "LoanRepaymentPayment"("status", "submittedAt");
CREATE INDEX "LoanRepaymentPayment_applicationId_submittedAt_idx" ON "LoanRepaymentPayment"("applicationId", "submittedAt");
CREATE INDEX "LoanRepaymentPayment_installmentId_submittedAt_idx" ON "LoanRepaymentPayment"("installmentId", "submittedAt");
CREATE INDEX "LoanRepaymentPayment_userId_submittedAt_idx" ON "LoanRepaymentPayment"("userId", "submittedAt");

ALTER TABLE "LoanRepaymentPayment"
  ADD CONSTRAINT "LoanRepaymentPayment_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRepaymentPayment"
  ADD CONSTRAINT "LoanRepaymentPayment_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "LoanRepaymentInstallment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRepaymentPayment"
  ADD CONSTRAINT "LoanRepaymentPayment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
