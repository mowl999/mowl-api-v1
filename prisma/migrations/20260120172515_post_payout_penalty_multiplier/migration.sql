/*
  Warnings:

  - Changed the type of `recipientType` on the `Payout` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "Payout" DROP COLUMN "recipientType",
ADD COLUMN     "recipientType" "MemberType" NOT NULL;

-- AlterTable
ALTER TABLE "RuleConfig" ADD COLUMN     "postPayoutMissedPenaltyMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0;
