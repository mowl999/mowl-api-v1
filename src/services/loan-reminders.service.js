const { prisma } = require("../db");
const { sendLoanReminderEmail } = require("../utils/mailer");
const { getLoanSettings } = require("./loan-settings.service");

function startOfDay(value) {
  const d = new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function dayKey(value) {
  return startOfDay(value).toISOString().slice(0, 10);
}

function getDaysLate(dueDate, now = new Date()) {
  const due = startOfDay(dueDate).getTime();
  const today = startOfDay(now).getTime();
  return Math.max(0, Math.floor((today - due) / (24 * 60 * 60 * 1000)));
}

function overdueBucket(daysLate) {
  if (daysLate >= 30) return "30_PLUS";
  if (daysLate >= 8) return "8_30";
  if (daysLate >= 1) return "1_7";
  return null;
}

function buildReminderMessage({ application, installment, reminderType, daysLate, dueWindowDays }) {
  if (reminderType === "LOAN_REPAYMENT_DUE_SOON") {
    return {
      title: `Upcoming repayment due for ${application.product.name}`,
      message: `Installment ${installment.installmentNumber} is due on ${new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
      }).format(new Date(installment.dueDate))}. Pay it within the next ${dueWindowDays} days to keep your repayment plan current.`,
    };
  }

  return {
    title: `Overdue repayment for ${application.product.name}`,
    message: `Installment ${installment.installmentNumber} is now ${daysLate} day${daysLate === 1 ? "" : "s"} overdue. Please clear the outstanding balance to bring your loan back on schedule.`,
  };
}

async function createReminderEntry(tx, { installment, application, reminderType, periodKey, dueWindowDays, daysLate, inAppEnabled }) {
  const existing = await tx.loanRepaymentReminderLog.findUnique({
    where: {
      installmentId_reminderType_periodKey: {
        installmentId: installment.id,
        reminderType,
        periodKey,
      },
    },
  });
  if (existing) return null;

  const content = buildReminderMessage({
    application,
    installment,
    reminderType,
    daysLate,
    dueWindowDays,
  });

  const notification = inAppEnabled
    ? await tx.userNotification.create({
        data: {
          userId: application.userId,
          workspace: "LOANS",
          type: reminderType,
          title: content.title,
          message: content.message,
          data: {
            applicationId: application.id,
            installmentId: installment.id,
            installmentNumber: installment.installmentNumber,
            dueDate: installment.dueDate,
            outstandingAmount: Number(installment.totalDue || 0) - Number(installment.amountPaid || 0),
            periodKey,
          },
        },
      })
    : null;

  const reminderLog = await tx.loanRepaymentReminderLog.create({
    data: {
      installmentId: installment.id,
      userId: application.userId,
      notificationId: notification?.id || null,
      reminderType,
      periodKey,
      emailSent: false,
    },
  });

  return { notification, reminderLog, content };
}

async function runLoanReminderJob(db = prisma) {
  const now = new Date();
  const settings = await getLoanSettings(db);
  const dueWindowDays = Math.max(1, Number(settings.upcomingReminderDays || 7));
  const overdueRepeatDays = Math.max(1, Number(settings.overdueReminderRepeatDays || 7));
  const upcomingCutoff = addDays(startOfDay(now), dueWindowDays);

  const installments = await db.loanRepaymentInstallment.findMany({
    where: {
      status: { in: ["PENDING", "PARTIAL", "OVERDUE"] },
      application: {
        status: "APPROVED",
        disbursedAt: { not: null },
      },
    },
    include: {
      application: {
        include: {
          user: { select: { id: true, email: true, fullName: true } },
          product: { select: { name: true, currency: true } },
        },
      },
    },
  });

  const summary = {
    scanned: installments.length,
    dueSoonCreated: 0,
    overdueCreated: 0,
    emailsSent: 0,
  };

  for (const installment of installments) {
    const outstandingAmount = Number(installment.totalDue || 0) - Number(installment.amountPaid || 0);
    if (outstandingAmount <= 0) continue;

    let reminderType = null;
    let periodKey = null;
    let daysLate = 0;
    const dueDate = new Date(installment.dueDate);

    if (startOfDay(dueDate) > startOfDay(now) && startOfDay(dueDate) <= upcomingCutoff) {
      reminderType = "LOAN_REPAYMENT_DUE_SOON";
      periodKey = `due:${dayKey(dueDate)}`;
    } else if (startOfDay(dueDate) <= startOfDay(now)) {
      daysLate = getDaysLate(dueDate, now);
      const bucket = overdueBucket(daysLate);
      if (bucket) {
        reminderType = "LOAN_REPAYMENT_OVERDUE";
        const cadenceStep = Math.floor((Math.max(daysLate, 1) - 1) / overdueRepeatDays) + 1;
        periodKey = `overdue:${bucket}:step:${cadenceStep}:${dayKey(dueDate)}`;
      }
    }

    if (!reminderType || !periodKey) continue;

    const created = await db.$transaction((tx) =>
      createReminderEntry(tx, {
        installment,
        application: installment.application,
        reminderType,
        periodKey,
        dueWindowDays,
        daysLate,
        inAppEnabled: settings.inAppRemindersEnabled,
      })
    );

    if (!created) continue;

    if (reminderType === "LOAN_REPAYMENT_DUE_SOON") summary.dueSoonCreated += 1;
    if (reminderType === "LOAN_REPAYMENT_OVERDUE") summary.overdueCreated += 1;

    let emailSent = false;
    if (settings.emailRemindersEnabled) {
      const actionUrl = `${process.env.FRONTEND_APP_URL || "http://localhost:5173"}/app/loans/repayments`;
      emailSent = await sendLoanReminderEmail({
        to: installment.application.user.email,
        reminderType,
        borrowerName: installment.application.user.fullName || installment.application.user.email,
        productName: installment.application.product.name,
        installmentNumber: installment.installmentNumber,
        dueDate: installment.dueDate,
        outstandingAmount,
        currency: installment.application.product.currency || "GBP",
        daysLate,
        actionUrl,
      });
    }

    if (emailSent) {
      summary.emailsSent += 1;
      await db.loanRepaymentReminderLog.update({
        where: { id: created.reminderLog.id },
        data: { emailSent: true },
      });
    }
  }

  return summary;
}

function startLoanReminderScheduler() {
  if (String(process.env.ENABLE_LOAN_REMINDER_JOBS || "false") !== "true") return null;
  const intervalMs = Math.max(5, Number(process.env.LOAN_REMINDER_INTERVAL_MINUTES || 60)) * 60 * 1000;

  const run = async () => {
    try {
      const summary = await runLoanReminderJob(prisma);
      console.log("[loan-reminders]", summary);
    } catch (err) {
      console.error("[loan-reminders] failed", err);
    }
  };

  run();
  return setInterval(run, intervalMs);
}

module.exports = {
  getDaysLate,
  overdueBucket,
  runLoanReminderJob,
  startLoanReminderScheduler,
};
