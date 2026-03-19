CREATE TYPE "LoanApplicationUpdateType" AS ENUM (
  'APPLICATION_CREATED',
  'APPLICATION_UPDATED',
  'DOCUMENT_UPLOADED',
  'DOCUMENT_REMOVED',
  'SUBMITTED',
  'INFO_REQUESTED',
  'CUSTOMER_RESPONSE',
  'APPROVED',
  'REJECTED',
  'DISBURSED',
  'SCHEDULE_GENERATED'
);

CREATE TYPE "LoanRepaymentStatus" AS ENUM (
  'PENDING',
  'PARTIAL',
  'PAID',
  'OVERDUE',
  'WAIVED'
);

ALTER TABLE "LoanProduct"
  ADD COLUMN "annualInterestRatePct" DOUBLE PRECISION NOT NULL DEFAULT 0.18,
  ADD COLUMN "processingFeePct" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "LoanApplication"
  ADD COLUMN "approvedAmount" DOUBLE PRECISION,
  ADD COLUMN "approvedTermMonths" INTEGER,
  ADD COLUMN "annualInterestRatePct" DOUBLE PRECISION,
  ADD COLUMN "processingFeePct" DOUBLE PRECISION,
  ADD COLUMN "disbursedAmount" DOUBLE PRECISION,
  ADD COLUMN "disbursementRef" TEXT,
  ADD COLUMN "disbursedById" TEXT,
  ADD COLUMN "disbursedAt" TIMESTAMP(3),
  ADD COLUMN "repaymentStartDate" TIMESTAMP(3);

ALTER TABLE "LoanTransaction"
  ADD COLUMN "applicationId" TEXT,
  ADD COLUMN "installmentId" TEXT;

CREATE TABLE "LoanApplicationUpdate" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "entryType" "LoanApplicationUpdateType" NOT NULL,
  "title" TEXT NOT NULL,
  "note" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanApplicationUpdate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoanRepaymentInstallment" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "installmentNumber" INTEGER NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "principalAmount" DOUBLE PRECISION NOT NULL,
  "interestAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "feeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalDue" DOUBLE PRECISION NOT NULL,
  "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" "LoanRepaymentStatus" NOT NULL DEFAULT 'PENDING',
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanRepaymentInstallment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoanRepaymentInstallment_applicationId_installmentNumber_key"
  ON "LoanRepaymentInstallment"("applicationId", "installmentNumber");

CREATE INDEX "LoanApplicationUpdate_applicationId_createdAt_idx"
  ON "LoanApplicationUpdate"("applicationId", "createdAt");

CREATE INDEX "LoanRepaymentInstallment_applicationId_dueDate_idx"
  ON "LoanRepaymentInstallment"("applicationId", "dueDate");

CREATE INDEX "LoanRepaymentInstallment_status_dueDate_idx"
  ON "LoanRepaymentInstallment"("status", "dueDate");

CREATE INDEX "LoanTransaction_applicationId_createdAt_idx"
  ON "LoanTransaction"("applicationId", "createdAt");

CREATE INDEX "LoanTransaction_installmentId_idx"
  ON "LoanTransaction"("installmentId");

ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_disbursedById_fkey"
  FOREIGN KEY ("disbursedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LoanApplicationUpdate"
  ADD CONSTRAINT "LoanApplicationUpdate_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRepaymentInstallment"
  ADD CONSTRAINT "LoanRepaymentInstallment_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanTransaction"
  ADD CONSTRAINT "LoanTransaction_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LoanTransaction"
  ADD CONSTRAINT "LoanTransaction_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "LoanRepaymentInstallment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "LoanProduct"
SET
  "annualInterestRatePct" = CASE
    WHEN slug = 'personal-loan' THEN 0.16
    WHEN slug = 'business-loan' THEN 0.18
    WHEN slug = 'school-fees-loan' THEN 0.12
    ELSE "annualInterestRatePct"
  END,
  "processingFeePct" = CASE
    WHEN slug = 'personal-loan' THEN 0.01
    WHEN slug = 'business-loan' THEN 0.015
    WHEN slug = 'school-fees-loan' THEN 0.005
    ELSE "processingFeePct"
  END,
  "requiredDocuments" = CASE
    WHEN slug = 'personal-loan' THEN '["IDENTITY","EMPLOYMENT_EVIDENCE","BANK_STATEMENT"]'::jsonb
    WHEN slug = 'business-loan' THEN '["IDENTITY","BUSINESS_PROOF","BANK_STATEMENT"]'::jsonb
    WHEN slug = 'school-fees-loan' THEN '["IDENTITY","BANK_STATEMENT","OTHER"]'::jsonb
    ELSE "requiredDocuments"
  END
WHERE slug IN ('personal-loan', 'business-loan', 'school-fees-loan');
