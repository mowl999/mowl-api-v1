ALTER TABLE "User"
ADD COLUMN "firstName" TEXT,
ADD COLUMN "lastName" TEXT;

UPDATE "User"
SET
  "firstName" = CASE
    WHEN trim(split_part("fullName", ' ', 1)) = '' THEN NULL
    ELSE trim(split_part("fullName", ' ', 1))
  END,
  "lastName" = CASE
    WHEN strpos(trim("fullName"), ' ') > 0 THEN trim(substr(trim("fullName"), strpos(trim("fullName"), ' ') + 1))
    ELSE NULL
  END
WHERE "firstName" IS NULL AND "lastName" IS NULL;
