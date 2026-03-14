/*
  Warnings:

  - The values [CONTRIBUTION] on the enum `CreditReason` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "CreditReason_new" AS ENUM ('INITIAL_DEPOSIT', 'CONTRIBUTION_PAID', 'CONTRIBUTION_LATE', 'PENALTY', 'SWAP_FEE', 'ADMIN_ADJUSTMENT');
ALTER TABLE "CreditLedger" ALTER COLUMN "reason" TYPE "CreditReason_new" USING ("reason"::text::"CreditReason_new");
ALTER TYPE "CreditReason" RENAME TO "CreditReason_old";
ALTER TYPE "CreditReason_new" RENAME TO "CreditReason";
DROP TYPE "public"."CreditReason_old";
COMMIT;

-- AlterTable
ALTER TABLE "Contribution" ALTER COLUMN "status" SET DEFAULT 'PENDING';
