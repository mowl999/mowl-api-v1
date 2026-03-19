CREATE TABLE "LoanSettings" (
  "id" TEXT NOT NULL,
  "upcomingReminderDays" INTEGER NOT NULL DEFAULT 7,
  "overdueReminderRepeatDays" INTEGER NOT NULL DEFAULT 7,
  "emailRemindersEnabled" BOOLEAN NOT NULL DEFAULT true,
  "inAppRemindersEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LoanSettings_pkey" PRIMARY KEY ("id")
);
