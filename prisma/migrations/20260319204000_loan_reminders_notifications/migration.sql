CREATE TYPE "UserNotificationType" AS ENUM ('LOAN_REPAYMENT_DUE_SOON', 'LOAN_REPAYMENT_OVERDUE');

CREATE TABLE "UserNotification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspace" "WorkspaceKey" NOT NULL,
  "type" "UserNotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "data" JSONB,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoanRepaymentReminderLog" (
  "id" TEXT NOT NULL,
  "installmentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "notificationId" TEXT,
  "reminderType" "UserNotificationType" NOT NULL,
  "periodKey" TEXT NOT NULL,
  "emailSent" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoanRepaymentReminderLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserNotification_userId_workspace_createdAt_idx" ON "UserNotification"("userId", "workspace", "createdAt");
CREATE INDEX "UserNotification_type_createdAt_idx" ON "UserNotification"("type", "createdAt");
CREATE INDEX "LoanRepaymentReminderLog_userId_createdAt_idx" ON "LoanRepaymentReminderLog"("userId", "createdAt");
CREATE INDEX "LoanRepaymentReminderLog_reminderType_createdAt_idx" ON "LoanRepaymentReminderLog"("reminderType", "createdAt");
CREATE UNIQUE INDEX "LoanRepaymentReminderLog_installmentId_reminderType_periodKey_key" ON "LoanRepaymentReminderLog"("installmentId", "reminderType", "periodKey");

ALTER TABLE "UserNotification"
  ADD CONSTRAINT "UserNotification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRepaymentReminderLog"
  ADD CONSTRAINT "LoanRepaymentReminderLog_installmentId_fkey"
  FOREIGN KEY ("installmentId") REFERENCES "LoanRepaymentInstallment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRepaymentReminderLog"
  ADD CONSTRAINT "LoanRepaymentReminderLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRepaymentReminderLog"
  ADD CONSTRAINT "LoanRepaymentReminderLog_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "UserNotification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
