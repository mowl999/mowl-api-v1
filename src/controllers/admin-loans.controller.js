const { z } = require("zod");
const { prisma } = require("../db");
const { getDaysLate, overdueBucket, runLoanReminderJob } = require("../services/loan-reminders.service");
const { getLoanSettings } = require("../services/loan-settings.service");
const {
  addLoanApplicationUpdate,
  adminLoanApplicationInclude,
  buildRepaymentSchedule,
  computeInstallmentStatus,
  ensureDefaultLoanProducts,
  normalizeRequiredDocuments,
  roundMoney,
  serializeLoanApplication,
} = require("../services/loan-applications.service");

const LOAN_DOCUMENT_TYPES = [
  "IDENTITY",
  "EMPLOYMENT_EVIDENCE",
  "BANK_STATEMENT",
  "BUSINESS_PROOF",
  "ADDRESS_PROOF",
  "OTHER",
];

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_INFO"]),
  reviewNote: z.string().trim().min(3).max(500),
  approvedAmount: z.coerce.number().positive().optional(),
  approvedTermMonths: z.coerce.number().int().min(1).optional(),
});

const updateProductSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  minAmount: z.number().positive().optional(),
  maxAmount: z.number().positive().optional(),
  minTermMonths: z.number().int().min(1).optional(),
  maxTermMonths: z.number().int().min(1).optional(),
  annualInterestRatePct: z.number().min(0).max(1).optional(),
  processingFeePct: z.number().min(0).max(1).optional(),
  equityRequirementPct: z.number().min(0).max(1).optional(),
  minimumEquityAmount: z.number().min(0).optional(),
  requiredDocuments: z.array(z.enum(LOAN_DOCUMENT_TYPES)).max(6).optional(),
  isActive: z.boolean().optional(),
});

const createProductSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  minAmount: z.number().positive(),
  maxAmount: z.number().positive(),
  minTermMonths: z.number().int().min(1),
  maxTermMonths: z.number().int().min(1),
  annualInterestRatePct: z.number().min(0).max(1),
  processingFeePct: z.number().min(0).max(1).default(0),
  equityRequirementPct: z.number().min(0).max(1).default(0),
  minimumEquityAmount: z.number().min(0).default(0),
  requiredDocuments: z.array(z.enum(LOAN_DOCUMENT_TYPES)).max(6).optional().default([]),
  isActive: z.boolean().default(true),
});

const reviewEquityPaymentSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reviewNote: z.string().trim().min(3).max(300).optional(),
  paymentRef: z.string().trim().min(3).max(120).optional(),
});

const reviewRepaymentPaymentSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reviewNote: z.string().trim().min(3).max(300).optional(),
  paymentRef: z.string().trim().min(3).max(120).optional(),
});

const disburseLoanSchema = z.object({
  disbursedAmount: z.coerce.number().positive().optional(),
  repaymentStartDate: z.string().trim().min(5),
  disbursementRef: z.string().trim().min(3).max(120).optional(),
  note: z.string().trim().min(3).max(500).optional(),
});
const updateLoanSettingsSchema = z.object({
  upcomingReminderDays: z.coerce.number().int().min(1).max(30),
  overdueReminderRepeatDays: z.coerce.number().int().min(1).max(30),
  emailRemindersEnabled: z.boolean(),
  inAppRemindersEnabled: z.boolean(),
});

function requiredEquity(application) {
  return Math.max(
    Number(application.amountRequested || 0) * Number(application.product?.equityRequirementPct || 0),
    Number(application.product?.minimumEquityAmount || 0)
  );
}

function confirmedEquity(application) {
  return Number((application.equityContributions || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
}

function parseDateInput(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function slugifyProductName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function sumOutstanding(installments) {
  return installments.reduce(
    (sum, item) => sum + roundMoney(Math.max(Number(item.totalDue || 0) - Number(item.amountPaid || 0), 0)),
    0
  );
}

async function logUpdate(tx, applicationId, actorType, entryType, title, note = null, metadata = null) {
  return addLoanApplicationUpdate(tx, { applicationId, actorType, entryType, title, note, metadata });
}

async function postApprovedRepayment(tx, { payment, reference, note }) {
  const installment = await tx.loanRepaymentInstallment.findUnique({
    where: { id: payment.installmentId },
    include: {
      application: {
        include: {
          product: { select: { currency: true, name: true } },
        },
      },
    },
  });

  if (!installment) {
    throw { status: 404, code: "NOT_FOUND", message: "Loan repayment installment not found." };
  }

  const outstandingBefore = roundMoney(Math.max(Number(installment.totalDue || 0) - Number(installment.amountPaid || 0), 0));
  if (outstandingBefore <= 0) {
    throw { status: 409, code: "INSTALLMENT_ALREADY_SETTLED", message: "This installment has already been fully settled." };
  }
  if (Number(payment.amount || 0) > outstandingBefore + 0.01) {
    throw {
      status: 409,
      code: "PAYMENT_EXCEEDS_INSTALLMENT",
      message: `Payment exceeds the remaining installment balance of ${outstandingBefore.toFixed(2)}.`,
    };
  }

  const nextAmountPaid = roundMoney(Number(installment.amountPaid || 0) + Number(payment.amount || 0));
  const nextStatus = computeInstallmentStatus({
    totalDue: installment.totalDue,
    amountPaid: nextAmountPaid,
    dueDate: installment.dueDate,
  });
  const paymentRef = reference || payment.userReference || payment.providerRef || `LOANRP-${Date.now()}`;

  const approvedPayment = await tx.loanRepaymentPayment.update({
    where: { id: payment.id },
    data: {
      status: "APPROVED",
      reviewedById: payment.reviewedById || null,
      reviewedAt: payment.reviewedAt || new Date(),
      reviewNote: note || payment.reviewNote || "Approved repayment payment",
      providerRef: payment.providerRef || paymentRef,
    },
  });

  const updatedInstallment = await tx.loanRepaymentInstallment.update({
    where: { id: installment.id },
    data: {
      amountPaid: nextAmountPaid,
      status: nextStatus,
      paidAt: nextStatus === "PAID" ? new Date() : null,
    },
  });

  await tx.loanTransaction.create({
    data: {
      userId: payment.userId,
      applicationId: payment.applicationId,
      installmentId: payment.installmentId,
      type: "REPAYMENT",
      direction: "DEBIT",
      amount: payment.amount,
      currency: payment.currency || installment.application.product.currency || "GBP",
      reference: paymentRef,
      note: note || payment.note || `Repayment received for installment ${installment.installmentNumber}`,
      metadata: {
        paymentId: payment.id,
        channel: payment.channel,
        installmentNumber: installment.installmentNumber,
      },
    },
  });

  await logUpdate(
    tx,
    payment.applicationId,
    payment.reviewedById === "SYSTEM" ? "SYSTEM" : "ADMIN",
    "APPLICATION_UPDATED",
    "Repayment posted",
    note || `Repayment of ${Number(payment.amount || 0).toFixed(2)} posted to installment ${installment.installmentNumber}.`,
    {
      paymentId: payment.id,
      installmentId: payment.installmentId,
      installmentNumber: installment.installmentNumber,
      amount: Number(payment.amount || 0),
      status: updatedInstallment.status,
    }
  );

  return { approvedPayment, updatedInstallment, applicationId: payment.applicationId };
}

exports.listAdminLoanApplications = async (req, res) => {
  try {
    await ensureDefaultLoanProducts(prisma);
    const status = String(req.query.status || "SUBMITTED").toUpperCase();
    const where = status === "ALL" ? {} : { status };

    const items = await prisma.loanApplication.findMany({
      where,
      orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
      include: adminLoanApplicationInclude,
      take: 300,
    });

    return res.json({ items: items.map(serializeLoanApplication) });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_APPLICATION_MODEL_NOT_READY",
          message: "Loan application tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.getAdminLoanDashboard = async (req, res) => {
  try {
    const now = new Date();
    const upcomingCutoff = new Date(now);
    upcomingCutoff.setDate(upcomingCutoff.getDate() + 7);
    const last7d = new Date(now);
    last7d.setDate(last7d.getDate() - 7);

    const [
      productsCount,
      activeProductsCount,
      applicationsCount,
      submittedCount,
      moreInfoCount,
      approvedCount,
      disbursedCount,
      pendingEquityReviews,
      pendingRepaymentReviews,
      installments,
      repaymentAgg,
      reminderLogs,
      loanSettings,
    ] = await Promise.all([
      prisma.loanProduct.count().catch(() => 0),
      prisma.loanProduct.count({ where: { isActive: true } }).catch(() => 0),
      prisma.loanApplication.count().catch(() => 0),
      prisma.loanApplication.count({ where: { status: "SUBMITTED" } }).catch(() => 0),
      prisma.loanApplication.count({ where: { status: "MORE_INFO_REQUIRED" } }).catch(() => 0),
      prisma.loanApplication.count({ where: { status: "APPROVED" } }).catch(() => 0),
      prisma.loanApplication.count({ where: { disbursedAt: { not: null } } }).catch(() => 0),
      prisma.loanEquityPayment.count({ where: { status: "SUBMITTED" } }).catch(() => 0),
      prisma.loanRepaymentPayment.count({ where: { status: "SUBMITTED" } }).catch(() => 0),
      prisma.loanRepaymentInstallment
        .findMany({
          where: {
            application: {
              disbursedAt: { not: null },
            },
          },
          select: {
            id: true,
            dueDate: true,
            totalDue: true,
            amountPaid: true,
            status: true,
          },
        })
        .catch(() => []),
      prisma.loanTransaction
        .aggregate({
          where: { type: "REPAYMENT", direction: "DEBIT" },
          _sum: { amount: true },
        })
        .catch(() => ({ _sum: { amount: 0 } })),
      prisma.loanRepaymentReminderLog
        .findMany({
          where: { createdAt: { gte: last7d } },
          select: { reminderType: true, emailSent: true, createdAt: true },
        })
        .catch(() => []),
      getLoanSettings(prisma),
    ]);

    const openInstallments = installments.filter(
      (item) => roundMoney(Math.max(Number(item.totalDue || 0) - Number(item.amountPaid || 0), 0)) > 0
    );
    const dueSoonCount = openInstallments.filter((item) => {
      const dueDate = new Date(item.dueDate);
      return dueDate >= now && dueDate <= upcomingCutoff;
    }).length;

    const agingBuckets = {
      d1To7: 0,
      d8To30: 0,
      d30Plus: 0,
    };

    for (const installment of openInstallments) {
      const daysLate = getDaysLate(installment.dueDate, now);
      const bucket = overdueBucket(daysLate);
      if (bucket === "1_7") agingBuckets.d1To7 += 1;
      if (bucket === "8_30") agingBuckets.d8To30 += 1;
      if (bucket === "30_PLUS") agingBuckets.d30Plus += 1;
    }

    return res.json({
      overview: {
        productsCount,
        activeProductsCount,
        applicationsCount,
        submittedCount,
        moreInfoCount,
        approvedCount,
        disbursedCount,
      },
      queues: {
        pendingEquityReviews,
        pendingRepaymentReviews,
      },
      repayments: {
        openInstallments: openInstallments.length,
        dueSoonCount,
        overdueCount: agingBuckets.d1To7 + agingBuckets.d8To30 + agingBuckets.d30Plus,
        repaidTotal: Number((repaymentAgg?._sum?.amount || 0).toFixed(2)),
        outstandingTotal: roundMoney(sumOutstanding(openInstallments)),
        agingBuckets,
      },
      reminders: {
        last7dTotal: reminderLogs.length,
        dueSoonSent: reminderLogs.filter((item) => item.reminderType === "LOAN_REPAYMENT_DUE_SOON").length,
        overdueSent: reminderLogs.filter((item) => item.reminderType === "LOAN_REPAYMENT_OVERDUE").length,
        emailsSent: reminderLogs.filter((item) => item.emailSent).length,
      },
      settings: loanSettings,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.getAdminLoanSettings = async (req, res) => {
  try {
    const settings = await getLoanSettings(prisma);
    return res.json({ settings });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to load loan settings." } });
  }
};

exports.updateAdminLoanSettings = async (req, res) => {
  const parsed = updateLoanSettingsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid loan settings payload.", details: parsed.error.flatten() },
    });
  }

  try {
    const existing = await getLoanSettings(prisma);
    const settings = await prisma.loanSettings.update({
      where: { id: existing.id },
      data: {
        upcomingReminderDays: parsed.data.upcomingReminderDays,
        overdueReminderRepeatDays: parsed.data.overdueReminderRepeatDays,
        emailRemindersEnabled: parsed.data.emailRemindersEnabled,
        inAppRemindersEnabled: parsed.data.inAppRemindersEnabled,
      },
    });
    return res.json({ settings });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to update loan settings." } });
  }
};

exports.runAdminLoanReminderJob = async (req, res) => {
  try {
    const summary = await runLoanReminderJob(prisma);
    return res.json({ summary, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Failed to run loan reminders." } });
  }
};

exports.reviewLoanApplication = async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid review payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const application = await prisma.loanApplication.findUnique({
      where: { id: req.params.applicationId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            minAmount: true,
            maxAmount: true,
            minTermMonths: true,
            maxTermMonths: true,
            annualInterestRatePct: true,
            processingFeePct: true,
            equityRequirementPct: true,
            minimumEquityAmount: true,
          },
        },
        documents: { select: { id: true } },
        equityContributions: { select: { amount: true } },
      },
    });

    if (!application) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Loan application not found." } });
    }

    if (!["SUBMITTED", "IN_REVIEW", "MORE_INFO_REQUIRED"].includes(application.status)) {
      return res.status(409).json({
        error: {
          code: "APPLICATION_ALREADY_REVIEWED",
          message: "Only submitted or returned loan applications can be reviewed.",
        },
      });
    }

    if ((application.documents || []).length === 0) {
      return res.status(409).json({
        error: {
          code: "DOCUMENT_REQUIRED",
          message: "This loan application has no uploaded documents yet.",
        },
      });
    }

    const approvedAmount = parsed.data.approvedAmount ?? Number(application.amountRequested || 0);
    const approvedTermMonths = parsed.data.approvedTermMonths ?? Number(application.termMonths || 0);

    if (parsed.data.decision === "APPROVE") {
      const needed = requiredEquity(application);
      const funded = confirmedEquity(application);
      if (funded + 0.01 < needed) {
        return res.status(409).json({
          error: {
            code: "EQUITY_REQUIREMENT_NOT_MET",
            message: `Required equity has not been fully funded. Required ${needed.toFixed(2)}, confirmed ${funded.toFixed(2)}.`,
          },
        });
      }
      if (approvedAmount < Number(application.product.minAmount) || approvedAmount > Number(application.product.maxAmount)) {
        return res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: `Approved amount must be between ${application.product.minAmount} and ${application.product.maxAmount}.`,
          },
        });
      }
      if (
        approvedTermMonths < Number(application.product.minTermMonths) ||
        approvedTermMonths > Number(application.product.maxTermMonths)
      ) {
        return res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: `Approved term must be between ${application.product.minTermMonths} and ${application.product.maxTermMonths} months.`,
          },
        });
      }
    }

    const item = await prisma.$transaction(async (tx) => {
      let nextStatus = "APPROVED";
      if (parsed.data.decision === "REJECT") nextStatus = "REJECTED";
      if (parsed.data.decision === "REQUEST_INFO") nextStatus = "MORE_INFO_REQUIRED";

      const updated = await tx.loanApplication.update({
        where: { id: application.id },
        data: {
          status: nextStatus,
          reviewNote: parsed.data.reviewNote,
          reviewedAt: new Date(),
          reviewedById: req.user?.id,
          approvedAmount: parsed.data.decision === "APPROVE" ? approvedAmount : application.approvedAmount,
          approvedTermMonths: parsed.data.decision === "APPROVE" ? approvedTermMonths : application.approvedTermMonths,
          annualInterestRatePct:
            parsed.data.decision === "APPROVE"
              ? Number(application.product.annualInterestRatePct || 0)
              : application.annualInterestRatePct,
          processingFeePct:
            parsed.data.decision === "APPROVE"
              ? Number(application.product.processingFeePct || 0)
              : application.processingFeePct,
        },
        include: adminLoanApplicationInclude,
      });

      if (parsed.data.decision === "APPROVE") {
        await logUpdate(
          tx,
          application.id,
          "ADMIN",
          "APPROVED",
          "Loan application approved",
          parsed.data.reviewNote,
          {
            approvedAmount,
            approvedTermMonths,
            annualInterestRatePct: Number(application.product.annualInterestRatePct || 0),
            processingFeePct: Number(application.product.processingFeePct || 0),
          }
        );
      } else if (parsed.data.decision === "REQUEST_INFO") {
        await logUpdate(
          tx,
          application.id,
          "ADMIN",
          "INFO_REQUESTED",
          "Additional information requested",
          parsed.data.reviewNote,
          { previousStatus: application.status }
        );
      } else {
        await logUpdate(
          tx,
          application.id,
          "ADMIN",
          "REJECTED",
          "Loan application rejected",
          parsed.data.reviewNote,
          { previousStatus: application.status }
        );
      }

      return updated;
    });

    return res.json({ item: serializeLoanApplication(item) });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_APPLICATION_MODEL_NOT_READY",
          message: "Loan application tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.disburseLoanApplication = async (req, res) => {
  const parsed = disburseLoanSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid disbursement payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const firstDueDate = parseDateInput(parsed.data.repaymentStartDate);
    if (!firstDueDate) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Provide a valid first repayment date." },
      });
    }

    const application = await prisma.loanApplication.findUnique({
      where: { id: req.params.applicationId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            currency: true,
            annualInterestRatePct: true,
            processingFeePct: true,
          },
        },
        repaymentSchedule: { select: { id: true } },
      },
    });

    if (!application) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Loan application not found." } });
    }
    if (application.status !== "APPROVED") {
      return res.status(409).json({
        error: { code: "APPLICATION_NOT_APPROVED", message: "Only approved applications can be disbursed." },
      });
    }
    if (application.disbursedAt) {
      return res.status(409).json({
        error: { code: "ALREADY_DISBURSED", message: "Loan has already been disbursed." },
      });
    }

    const approvedAmount = Number(application.approvedAmount || application.amountRequested || 0);
    const approvedTermMonths = Number(application.approvedTermMonths || application.termMonths || 0);
    const annualInterestRatePct = Number(application.annualInterestRatePct ?? application.product.annualInterestRatePct ?? 0);
    const processingFeePct = Number(application.processingFeePct ?? application.product.processingFeePct ?? 0);
    const disbursedAmount = Number(parsed.data.disbursedAmount || approvedAmount);

    if (!approvedAmount || !approvedTermMonths) {
      return res.status(409).json({
        error: {
          code: "APPROVAL_TERMS_MISSING",
          message: "Approved amount and term must be captured before disbursement.",
        },
      });
    }

    const schedule = buildRepaymentSchedule({
      principal: disbursedAmount,
      termMonths: approvedTermMonths,
      annualInterestRatePct,
      processingFeePct,
      firstDueDate,
    });

    const ref = parsed.data.disbursementRef || `LOAN-${Date.now()}`;

    const item = await prisma.$transaction(async (tx) => {
      const updated = await tx.loanApplication.update({
        where: { id: application.id },
        data: {
          disbursedAmount,
          disbursementRef: ref,
          disbursedAt: new Date(),
          disbursedById: req.user?.id,
          repaymentStartDate: firstDueDate,
        },
      });

      await tx.loanRepaymentInstallment.createMany({
        data: schedule.map((entry) => ({
          applicationId: application.id,
          installmentNumber: entry.installmentNumber,
          dueDate: entry.dueDate,
          principalAmount: entry.principalAmount,
          interestAmount: entry.interestAmount,
          feeAmount: entry.feeAmount,
          totalDue: entry.totalDue,
          amountPaid: entry.amountPaid,
          status: entry.status,
        })),
      });

      await tx.loanTransaction.create({
        data: {
          userId: application.userId,
          applicationId: application.id,
          type: "DISBURSEMENT",
          direction: "CREDIT",
          amount: disbursedAmount,
          currency: application.product.currency || "GBP",
          reference: ref,
          note: parsed.data.note || "Loan disbursed",
          metadata: {
            approvedAmount,
            approvedTermMonths,
            annualInterestRatePct,
            processingFeePct,
          },
        },
      });

      await logUpdate(
        tx,
        application.id,
        "ADMIN",
        "DISBURSED",
        "Loan disbursed",
        parsed.data.note || `Disbursed ${disbursedAmount.toFixed(2)} with reference ${ref}.`,
        {
          disbursedAmount,
          disbursementRef: ref,
          repaymentStartDate: firstDueDate,
        }
      );
      await logUpdate(
        tx,
        application.id,
        "SYSTEM",
        "SCHEDULE_GENERATED",
        "Repayment schedule generated",
        `${schedule.length} repayment installments created.`,
        {
          installmentsCount: schedule.length,
          annualInterestRatePct,
          processingFeePct,
        }
      );

      return tx.loanApplication.findUnique({
        where: { id: updated.id },
        include: adminLoanApplicationInclude,
      });
    });

    return res.json({ item: serializeLoanApplication(item) });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_APPLICATION_MODEL_NOT_READY",
          message: "Loan application tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listAdminLoanProducts = async (req, res) => {
  try {
    await ensureDefaultLoanProducts(prisma);
    const items = await prisma.loanProduct.findMany({
      orderBy: { name: "asc" },
    });
    return res.json({
      items: items.map((item) => ({
        ...item,
        requiredDocuments: normalizeRequiredDocuments(item.requiredDocuments),
      })),
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_PRODUCT_MODEL_NOT_READY",
          message: "Loan product tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.createAdminLoanProduct = async (req, res) => {
  const parsed = createProductSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid loan product payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const data = {
      ...parsed.data,
      description: parsed.data.description?.trim() ? parsed.data.description.trim() : null,
      requiredDocuments: Array.from(new Set(parsed.data.requiredDocuments || [])),
    };

    if (data.minAmount > data.maxAmount) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Minimum amount cannot be greater than maximum amount." },
      });
    }
    if (data.minTermMonths > data.maxTermMonths) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Minimum term cannot be greater than maximum term." },
      });
    }

    const baseSlug = slugifyProductName(data.name);
    if (!baseSlug) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Loan product name must contain letters or numbers." },
      });
    }

    let slug = baseSlug;
    let suffix = 2;
    // Keep the slug deterministic and unique without adding UI complexity.
    while (await prisma.loanProduct.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    const product = await prisma.loanProduct.create({
      data: {
        slug,
        ...data,
      },
    });

    return res.status(201).json({
      product: {
        ...product,
        requiredDocuments: normalizeRequiredDocuments(product.requiredDocuments),
      },
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_PRODUCT_MODEL_NOT_READY",
          message: "Loan product tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.updateAdminLoanProduct = async (req, res) => {
  const parsed = updateProductSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid loan product payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const current = await prisma.loanProduct.findUnique({ where: { id: req.params.productId } });
    if (!current) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Loan product not found." } });
    }

    const data = {
      ...parsed.data,
      description:
        parsed.data.description === undefined ? undefined : parsed.data.description?.trim() ? parsed.data.description.trim() : null,
      requiredDocuments:
        parsed.data.requiredDocuments === undefined
          ? undefined
          : Array.from(new Set(parsed.data.requiredDocuments)),
    };

    const minAmount = data.minAmount ?? current.minAmount;
    const maxAmount = data.maxAmount ?? current.maxAmount;
    const minTermMonths = data.minTermMonths ?? current.minTermMonths;
    const maxTermMonths = data.maxTermMonths ?? current.maxTermMonths;
    if (minAmount > maxAmount) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Minimum amount cannot be greater than maximum amount." },
      });
    }
    if (minTermMonths > maxTermMonths) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Minimum term cannot be greater than maximum term." },
      });
    }

    const product = await prisma.loanProduct.update({
      where: { id: current.id },
      data,
    });

    return res.json({
      product: {
        ...product,
        requiredDocuments: normalizeRequiredDocuments(product.requiredDocuments),
      },
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_PRODUCT_MODEL_NOT_READY",
          message: "Loan product tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listAdminLoanEquityPayments = async (req, res) => {
  try {
    const status = String(req.query.status || "SUBMITTED").toUpperCase();
    const where = status === "ALL" ? {} : { status };
    const items = await prisma.loanEquityPayment.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      take: 300,
      select: {
        id: true,
        applicationId: true,
        userId: true,
        amount: true,
        currency: true,
        channel: true,
        status: true,
        providerRef: true,
        userReference: true,
        receiptUrl: true,
        note: true,
        reviewNote: true,
        reviewedById: true,
        submittedAt: true,
        reviewedAt: true,
        user: { select: { id: true, fullName: true, email: true } },
        application: {
          select: {
            id: true,
            amountRequested: true,
            status: true,
            product: { select: { id: true, name: true, currency: true, equityRequirementPct: true, minimumEquityAmount: true } },
            equityContributions: { select: { amount: true } },
          },
        },
      },
    });
    return res.json({
      items: items.map((item) => {
        const requiredAmount = requiredEquity(item.application);
        const confirmedAmount = confirmedEquity(item.application);
        return {
          ...item,
          amount: Number(item.amount || 0),
          application: {
            ...item.application,
            equity: {
              requiredAmount,
              confirmedAmount,
              remainingAmount: Math.max(requiredAmount - confirmedAmount, 0),
            },
          },
        };
      }),
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_EQUITY_MODEL_NOT_READY",
          message: "Loan equity tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.reviewAdminLoanEquityPayment = async (req, res) => {
  const parsed = reviewEquityPaymentSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid loan equity review payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const payment = await tx.loanEquityPayment.findUnique({
        where: { id: req.params.paymentId },
        include: {
          application: {
            include: {
              product: {
                select: {
                  currency: true,
                },
              },
              equityContributions: { select: { amount: true } },
            },
          },
          user: { select: { id: true, fullName: true, email: true } },
        },
      });

      if (!payment) throw { status: 404, code: "NOT_FOUND", message: "Loan equity payment not found." };
      if (payment.status !== "SUBMITTED") {
        throw { status: 409, code: "ALREADY_REVIEWED", message: "Loan equity payment already reviewed." };
      }

      if (parsed.data.decision === "REJECT") {
        const rejected = await tx.loanEquityPayment.update({
          where: { id: payment.id },
          data: {
            status: "REJECTED",
            reviewedById: req.user?.id,
            reviewedAt: new Date(),
            reviewNote: parsed.data.reviewNote || "Rejected by admin",
          },
        });
        return { payment: rejected, contribution: null };
      }

      const ref = parsed.data.paymentRef || payment.userReference || payment.providerRef || `LOANEQ-${Date.now()}`;
      const approved = await tx.loanEquityPayment.update({
        where: { id: payment.id },
        data: {
          status: "APPROVED",
          reviewedById: req.user?.id,
          reviewedAt: new Date(),
          reviewNote: parsed.data.reviewNote || "Approved by admin",
          providerRef: payment.providerRef || ref,
        },
      });

      const contribution = await tx.loanEquityContribution.create({
        data: {
          applicationId: payment.applicationId,
          userId: payment.userId,
          amount: payment.amount,
          currency: payment.currency,
          channel: payment.channel,
          paymentRef: ref,
          paidAt: new Date(),
        },
      });

      return { payment: approved, contribution };
    });

    return res.json({ payment: out.payment, contribution: out.contribution });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_EQUITY_MODEL_NOT_READY",
          message: "Loan equity tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listAdminLoanRepaymentPayments = async (req, res) => {
  try {
    const status = String(req.query.status || "SUBMITTED").toUpperCase();
    const where = status === "ALL" ? {} : { status };
    const items = await prisma.loanRepaymentPayment.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      take: 300,
      select: {
        id: true,
        applicationId: true,
        installmentId: true,
        userId: true,
        amount: true,
        currency: true,
        channel: true,
        status: true,
        providerRef: true,
        userReference: true,
        receiptUrl: true,
        note: true,
        reviewNote: true,
        reviewedById: true,
        submittedAt: true,
        reviewedAt: true,
        user: { select: { id: true, fullName: true, email: true } },
        application: {
          select: {
            id: true,
            status: true,
            approvedAmount: true,
            amountRequested: true,
            product: { select: { id: true, name: true, currency: true } },
          },
        },
        installment: {
          select: {
            id: true,
            installmentNumber: true,
            dueDate: true,
            totalDue: true,
            amountPaid: true,
            status: true,
          },
        },
      },
    });

    return res.json({
      items: items.map((item) => ({
        ...item,
        amount: Number(item.amount || 0),
        installment: {
          ...item.installment,
          totalDue: Number(item.installment.totalDue || 0),
          amountPaid: Number(item.installment.amountPaid || 0),
          outstandingAmount: roundMoney(
            Math.max(Number(item.installment.totalDue || 0) - Number(item.installment.amountPaid || 0), 0)
          ),
        },
      })),
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_REPAYMENT_MODEL_NOT_READY",
          message: "Loan repayment tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.reviewAdminLoanRepaymentPayment = async (req, res) => {
  const parsed = reviewRepaymentPaymentSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid loan repayment review payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const payment = await tx.loanRepaymentPayment.findUnique({
        where: { id: req.params.paymentId },
        include: {
          installment: { select: { id: true, installmentNumber: true, dueDate: true, totalDue: true, amountPaid: true, status: true } },
          application: {
            select: {
              id: true,
              product: { select: { currency: true } },
            },
          },
        },
      });

      if (!payment) throw { status: 404, code: "NOT_FOUND", message: "Loan repayment payment not found." };
      if (payment.status !== "SUBMITTED") {
        throw { status: 409, code: "ALREADY_REVIEWED", message: "Loan repayment payment already reviewed." };
      }

      if (parsed.data.decision === "REJECT") {
        const rejected = await tx.loanRepaymentPayment.update({
          where: { id: payment.id },
          data: {
            status: "REJECTED",
            reviewedById: req.user?.id,
            reviewedAt: new Date(),
            reviewNote: parsed.data.reviewNote || "Rejected by admin",
          },
        });
        return { payment: rejected, application: null };
      }

      const result = await postApprovedRepayment(tx, {
        payment: {
          ...payment,
          reviewedById: req.user?.id,
          reviewedAt: new Date(),
          reviewNote: parsed.data.reviewNote || "Approved by admin",
        },
        reference: parsed.data.paymentRef,
        note: parsed.data.reviewNote || payment.note || undefined,
      });

      const application = await tx.loanApplication.findUnique({
        where: { id: result.applicationId },
        include: adminLoanApplicationInclude,
      });

      return { payment: result.approvedPayment, application };
    });

    return res.json({ payment: out.payment, application: serializeLoanApplication(out.application) });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_REPAYMENT_MODEL_NOT_READY",
          message: "Loan repayment tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
