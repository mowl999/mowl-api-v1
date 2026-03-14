-- AlterEnum
ALTER TYPE "ContributionStatus" ADD VALUE IF NOT EXISTS 'PENDING';


-- AlterTable
ALTER TABLE "Contribution" ALTER COLUMN "paymentRef" DROP NOT NULL;


