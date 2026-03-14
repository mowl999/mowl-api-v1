CREATE TABLE "InvestmentUserRate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "annualRatePct" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentUserRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvestmentUserRate_userId_productId_key" ON "InvestmentUserRate"("userId", "productId");
CREATE INDEX "InvestmentUserRate_userId_productId_idx" ON "InvestmentUserRate"("userId", "productId");

ALTER TABLE "InvestmentUserRate" ADD CONSTRAINT "InvestmentUserRate_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvestmentUserRate" ADD CONSTRAINT "InvestmentUserRate_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "InvestmentProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

