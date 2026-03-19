-- CreateEnum
CREATE TYPE "LoanApplicationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'MORE_INFO_REQUIRED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LoanDocumentType" AS ENUM ('IDENTITY', 'EMPLOYMENT_EVIDENCE', 'BANK_STATEMENT', 'BUSINESS_PROOF', 'ADDRESS_PROOF', 'OTHER');

-- CreateTable
CREATE TABLE "LoanProduct" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minAmount" DOUBLE PRECISION NOT NULL,
    "maxAmount" DOUBLE PRECISION NOT NULL,
    "minTermMonths" INTEGER NOT NULL,
    "maxTermMonths" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "requiredDocuments" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "LoanApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "amountRequested" DOUBLE PRECISION NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "employmentStatus" TEXT,
    "employerName" TEXT,
    "businessName" TEXT,
    "monthlyIncomeSnapshot" DOUBLE PRECISION,
    "monthlyExpenseSnapshot" DOUBLE PRECISION,
    "applicantNote" TEXT,
    "reviewNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanApplicationDocument" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "documentType" "LoanDocumentType" NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageBucket" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanApplicationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanProduct_slug_key" ON "LoanProduct"("slug");

-- CreateIndex
CREATE INDEX "LoanApplication_userId_submittedAt_idx" ON "LoanApplication"("userId", "submittedAt");

-- CreateIndex
CREATE INDEX "LoanApplication_productId_submittedAt_idx" ON "LoanApplication"("productId", "submittedAt");

-- CreateIndex
CREATE INDEX "LoanApplication_status_submittedAt_idx" ON "LoanApplication"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "LoanApplicationDocument_applicationId_uploadedAt_idx" ON "LoanApplicationDocument"("applicationId", "uploadedAt");

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_productId_fkey" FOREIGN KEY ("productId") REFERENCES "LoanProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplicationDocument" ADD CONSTRAINT "LoanApplicationDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
