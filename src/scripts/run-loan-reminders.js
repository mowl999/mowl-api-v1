require("dotenv").config();

const { prisma } = require("../db");
const { runLoanReminderJob } = require("../services/loan-reminders.service");

async function main() {
  const summary = await runLoanReminderJob(prisma);
  console.log("[loan-reminders:run]", JSON.stringify(summary));
}

main()
  .catch((err) => {
    console.error("[loan-reminders:run] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
