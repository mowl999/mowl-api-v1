-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'SENT', 'CANCELLED');

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "cycleIndex" INTEGER NOT NULL,
    "recipientPosition" INTEGER NOT NULL,
    "recipientType" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "reference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payout_planId_cycleIndex_key" ON "Payout"("planId", "cycleIndex");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
