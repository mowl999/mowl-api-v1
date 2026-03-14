-- Patch migration for environments where PlanPause was created before admin-review fields existed.

ALTER TYPE "public"."PlanPauseStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED';
ALTER TYPE "public"."PlanPauseStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "public"."PlanPause"
  ADD COLUMN IF NOT EXISTS "reviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewNote" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "PlanPause_status_createdAt_idx"
  ON "public"."PlanPause"("status", "createdAt");
