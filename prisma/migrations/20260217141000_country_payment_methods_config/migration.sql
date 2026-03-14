ALTER TABLE "public"."RuleConfig"
ADD COLUMN "contributionsCountryCode" TEXT NOT NULL DEFAULT 'GB',
ADD COLUMN "contributionsEnabledPaymentMethods" JSONB;

UPDATE "public"."RuleConfig"
SET "contributionsEnabledPaymentMethods" = '["CARD","PAY_BY_BANK","DIRECT_DEBIT","BANK_TRANSFER_MANUAL"]'::jsonb
WHERE "contributionsEnabledPaymentMethods" IS NULL;
