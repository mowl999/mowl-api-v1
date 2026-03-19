const DEFAULT_LOAN_SETTINGS = {
  upcomingReminderDays: Math.max(1, Number(process.env.LOAN_REMINDER_UPCOMING_DAYS || 7)),
  overdueReminderRepeatDays: Math.max(1, Number(process.env.LOAN_REMINDER_REPEAT_DAYS || 7)),
  emailRemindersEnabled: String(process.env.LOAN_REMINDER_EMAIL_ENABLED || "true") !== "false",
  inAppRemindersEnabled: String(process.env.LOAN_REMINDER_INAPP_ENABLED || "true") !== "false",
};

async function getLoanSettings(db) {
  try {
    const item = await db.loanSettings.findFirst({ orderBy: { createdAt: "asc" } });
    if (item) return item;

    return db.loanSettings.create({
      data: {
        upcomingReminderDays: DEFAULT_LOAN_SETTINGS.upcomingReminderDays,
        overdueReminderRepeatDays: DEFAULT_LOAN_SETTINGS.overdueReminderRepeatDays,
        emailRemindersEnabled: DEFAULT_LOAN_SETTINGS.emailRemindersEnabled,
        inAppRemindersEnabled: DEFAULT_LOAN_SETTINGS.inAppRemindersEnabled,
      },
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return { id: "fallback", createdAt: new Date(), updatedAt: new Date(), ...DEFAULT_LOAN_SETTINGS };
    }
    throw err;
  }
}

module.exports = {
  DEFAULT_LOAN_SETTINGS,
  getLoanSettings,
};
