const { z } = require("zod");
const { prisma } = require("../db");
const {
  addLoanApplicationUpdate,
  computeInstallmentStatus,
  loanApplicationInclude,
  ensureDefaultLoanProducts,
  roundMoney,
  serializeLoanApplication,
} = require("../services/loan-applications.service");
const { uploadLoanDocument, openLoanDocument } = require("../utils/loan-documents-s3");

const LOAN_TYPES = new Set([
  "DISBURSEMENT",
  "REPAYMENT",
  "INTEREST_CHARGE",
  "FEE",
  "WAIVER",
  "ADJUSTMENT",
]);
const DIRECTIONS = new Set(["DEBIT", "CREDIT"]);
const DOCUMENT_TYPES = new Set([
  "IDENTITY",
  "EMPLOYMENT_EVIDENCE",
  "BANK_STATEMENT",
  "BUSINESS_PROOF",
  "ADDRESS_PROOF",
  "OTHER",
]);
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const LOAN_PAYMENT_METHODS = [
  {
    code: "STRIPE_CARD",
    label: "Stripe card payment",
    description: "Pay equity instantly by card. Confirmation is automatic after successful gateway capture.",
    submissionMode: "GATEWAY",
  },
  {
    code: "BANK_TRANSFER_MANUAL",
    label: "Manual bank transfer",
    description: "Transfer manually and submit your reference for admin confirmation.",
    submissionMode: "BANK_TRANSFER",
  },
];
const LOAN_REPAYMENT_PAYMENT_METHODS = [
  {
    code: "STRIPE_CARD",
    label: "Stripe card payment",
    description: "Pay this repayment instantly by card. Confirmation is automatic after successful gateway capture.",
    submissionMode: "GATEWAY",
  },
  {
    code: "BANK_TRANSFER_MANUAL",
    label: "Manual bank transfer",
    description: "Transfer manually and submit your repayment reference for admin confirmation.",
    submissionMode: "BANK_TRANSFER",
  },
];

const draftSchema = z.object({
  productId: z.string().min(1),
  amountRequested: z.coerce.number().positive(),
  termMonths: z.coerce.number().int().min(1),
  purpose: z.string().trim().min(10).max(500),
  employmentStatus: z.string().trim().max(120).optional().or(z.literal("")),
  employerName: z.string().trim().max(160).optional().or(z.literal("")),
  businessName: z.string().trim().max(160).optional().or(z.literal("")),
  monthlyIncomeSnapshot: z.coerce.number().min(0).optional(),
  monthlyExpenseSnapshot: z.coerce.number().min(0).optional(),
  applicantNote: z.string().trim().max(500).optional().or(z.literal("")),
});
const gatewayEquitySchema = z.object({
  amount: z.coerce.number().positive(),
  providerRef: z.string().min(3).optional(),
  note: z.string().max(300).optional(),
});
const manualEquitySchema = z.object({
  amount: z.coerce.number().positive(),
  userReference: z.string().min(3),
  note: z.string().max(300).optional(),
  receiptUrl: z.string().url().optional(),
});
const gatewayRepaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  providerRef: z.string().min(3).optional(),
  note: z.string().max(300).optional(),
});
const manualRepaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  userReference: z.string().min(3),
  note: z.string().max(300).optional(),
  receiptUrl: z.string().url().optional(),
});
const responseSchema = z.object({
  note: z.string().trim().min(3).max(500),
});
const reminderIdSchema = z.object({
  notificationId: z.string().min(1),
});
const LOAN_REMINDER_TYPES = ["LOAN_REPAYMENT_DUE_SOON", "LOAN_REPAYMENT_OVERDUE"];

function cleanNullableText(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function getEquityRequiredAmount(application) {
  const requirementPct = Number(application.product?.equityRequirementPct || 0);
  const minimumEquityAmount = Number(application.product?.minimumEquityAmount || 0);
  return Math.max(Number(application.amountRequested || 0) * requirementPct, minimumEquityAmount);
}

function getConfirmedEquityAmount(application) {
  return Number(
    (application.equityContributions || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  );
}

async function getOwnedLoanReminder(notificationId, userId) {
  return prisma.userNotification.findFirst({
    where: {
      id: notificationId,
      userId,
      workspace: "LOANS",
      type: { in: LOAN_REMINDER_TYPES },
    },
  });
}

async function countUnreadLoanReminders(userId) {
  return prisma.userNotification.count({
    where: {
      userId,
      workspace: "LOANS",
      type: { in: LOAN_REMINDER_TYPES },
      dismissedAt: null,
      isRead: false,
    },
  });
}

async function getMutableApplication({ applicationId, userId }) {
  const application = await prisma.loanApplication.findUnique({
    where: { id: applicationId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          minAmount: true,
          maxAmount: true,
          minTermMonths: true,
          maxTermMonths: true,
          isActive: true,
        },
      },
      documents: {
        select: { id: true },
      },
      equityContributions: {
        select: { id: true, amount: true },
      },
      equityPayments: {
        where: { status: { in: ["SUBMITTED", "APPROVED"] } },
        select: { id: true, channel: true, status: true, amount: true },
      },
    },
  });

  if (!application || application.userId !== userId) {
    throw { status: 404, code: "NOT_FOUND", message: "Loan application not found." };
  }

  if (!["DRAFT", "MORE_INFO_REQUIRED"].includes(application.status)) {
    throw {
      status: 409,
      code: "APPLICATION_LOCKED",
      message: "This loan application can no longer be edited.",
    };
  }

  return application;
}

async function getOwnedLoanApplication({ applicationId, userId }) {
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, userId },
    include: loanApplicationInclude,
  });
  if (!application) {
    throw { status: 404, code: "NOT_FOUND", message: "Loan application not found." };
  }
  return application;
}

async function validateProductAgainstApplication(payload) {
  const product = await prisma.loanProduct.findUnique({
    where: { id: payload.productId },
    select: {
      id: true,
      isActive: true,
      minAmount: true,
      maxAmount: true,
      minTermMonths: true,
      maxTermMonths: true,
      annualInterestRatePct: true,
      processingFeePct: true,
      equityRequirementPct: true,
      minimumEquityAmount: true,
      requiredDocuments: true,
    },
  });

  if (!product || !product.isActive) {
    throw { status: 400, code: "PRODUCT_NOT_AVAILABLE", message: "Selected loan product is not available." };
  }
  if (payload.amountRequested < product.minAmount || payload.amountRequested > product.maxAmount) {
    throw {
      status: 400,
      code: "AMOUNT_OUT_OF_RANGE",
      message: `Amount must be between ${product.minAmount} and ${product.maxAmount} for this product.`,
    };
  }
  if (payload.termMonths < product.minTermMonths || payload.termMonths > product.maxTermMonths) {
    throw {
      status: 400,
      code: "TERM_OUT_OF_RANGE",
      message: `Term must be between ${product.minTermMonths} and ${product.maxTermMonths} months for this product.`,
    };
  }
}

async function logUpdate(tx, applicationId, actorType, entryType, title, note = null, metadata = null) {
  return addLoanApplicationUpdate(tx, { applicationId, actorType, entryType, title, note, metadata });
}

async function assertNoEquityPaymentConflict(tx, applicationId, requestedChannel) {
  const active = await tx.loanEquityPayment.findFirst({
    where: {
      applicationId,
      status: { in: ["SUBMITTED", "APPROVED"] },
    },
    orderBy: [{ submittedAt: "desc" }],
    select: {
      id: true,
      channel: true,
      status: true,
    },
  });

  if (!active) return;
  if (active.channel !== requestedChannel) {
    throw {
      status: 409,
      code: "PAYMENT_METHOD_LOCKED",
      message: `Equity payment method is locked to ${active.channel} for this application.`,
      details: { activePaymentId: active.id, activeChannel: active.channel, activeStatus: active.status },
    };
  }
  if (active.status === "SUBMITTED") {
    throw {
      status: 409,
      code: "PAYMENT_ALREADY_SUBMITTED",
      message: "An equity payment submission is already pending review for this application.",
      details: { activePaymentId: active.id, activeChannel: active.channel },
    };
  }
}

async function assertNoRepaymentPaymentConflict(tx, installmentId, requestedChannel) {
  const active = await tx.loanRepaymentPayment.findFirst({
    where: {
      installmentId,
      status: { in: ["SUBMITTED", "APPROVED"] },
    },
    orderBy: [{ submittedAt: "desc" }],
    select: {
      id: true,
      channel: true,
      status: true,
    },
  });

  if (!active) return;
  if (active.channel !== requestedChannel) {
    throw {
      status: 409,
      code: "PAYMENT_METHOD_LOCKED",
      message: `Repayment payment method is locked to ${active.channel} for this installment.`,
      details: { activePaymentId: active.id, activeChannel: active.channel, activeStatus: active.status },
    };
  }
  if (active.status === "SUBMITTED") {
    throw {
      status: 409,
      code: "PAYMENT_ALREADY_SUBMITTED",
      message: "A repayment submission is already pending review for this installment.",
      details: { activePaymentId: active.id, activeChannel: active.channel },
    };
  }
}

async function getOwnedInstallment({ installmentId, userId }) {
  const installment = await prisma.loanRepaymentInstallment.findFirst({
    where: {
      id: installmentId,
      application: {
        userId,
      },
    },
    include: {
      application: {
        include: {
          product: { select: { id: true, name: true, currency: true } },
        },
      },
    },
  });

  if (!installment) {
    throw { status: 404, code: "NOT_FOUND", message: "Loan repayment installment not found." };
  }
  return installment;
}

async function applyGatewayRepayment(tx, { installment, userId, amount, providerRef, note }) {
  const outstandingBefore = roundMoney(Math.max(Number(installment.totalDue || 0) - Number(installment.amountPaid || 0), 0));
  if (outstandingBefore <= 0) {
    throw { status: 409, code: "INSTALLMENT_ALREADY_SETTLED", message: "This installment has already been fully settled." };
  }
  if (amount > outstandingBefore + 0.01) {
    throw {
      status: 400,
      code: "AMOUNT_EXCEEDS_INSTALLMENT",
      message: `Amount exceeds the remaining installment balance of ${outstandingBefore.toFixed(2)}.`,
    };
  }

  await assertNoRepaymentPaymentConflict(tx, installment.id, "GATEWAY");

  const ref = providerRef || `STRIPE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const payment = await tx.loanRepaymentPayment.create({
    data: {
      applicationId: installment.applicationId,
      installmentId: installment.id,
      userId,
      amount,
      currency: installment.application.product.currency || "GBP",
      channel: "GATEWAY",
      status: "APPROVED",
      providerRef: ref,
      note: note || null,
      reviewedById: "SYSTEM",
      reviewNote: "Auto-approved via Stripe gateway flow",
      reviewedAt: new Date(),
    },
  });

  const nextAmountPaid = roundMoney(Number(installment.amountPaid || 0) + amount);
  const nextStatus = computeInstallmentStatus({
    totalDue: installment.totalDue,
    amountPaid: nextAmountPaid,
    dueDate: installment.dueDate,
  });

  await tx.loanRepaymentInstallment.update({
    where: { id: installment.id },
    data: {
      amountPaid: nextAmountPaid,
      status: nextStatus,
      paidAt: nextStatus === "PAID" ? new Date() : null,
    },
  });

  await tx.loanTransaction.create({
    data: {
      userId,
      applicationId: installment.applicationId,
      installmentId: installment.id,
      type: "REPAYMENT",
      direction: "DEBIT",
      amount,
      currency: installment.application.product.currency || "GBP",
      reference: ref,
      note: note || `Repayment received for installment ${installment.installmentNumber}`,
      metadata: {
        paymentId: payment.id,
        channel: "GATEWAY",
        installmentNumber: installment.installmentNumber,
      },
    },
  });

  await logUpdate(
    tx,
    installment.applicationId,
    "SYSTEM",
    "APPLICATION_UPDATED",
    "Repayment received",
    `Repayment of ${amount.toFixed(2)} posted to installment ${installment.installmentNumber}.`,
    {
      paymentId: payment.id,
      installmentId: installment.id,
      installmentNumber: installment.installmentNumber,
      amount,
      channel: "GATEWAY",
    }
  );

  return payment;
}

exports.listLoanProducts = async (req, res) => {
  try {
    await ensureDefaultLoanProducts(prisma);
    const items = await prisma.loanProduct.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        slug: true,
      name: true,
      description: true,
      minAmount: true,
      maxAmount: true,
      minTermMonths: true,
      maxTermMonths: true,
      annualInterestRatePct: true,
      processingFeePct: true,
      equityRequirementPct: true,
      minimumEquityAmount: true,
      currency: true,
      requiredDocuments: true,
      isActive: true,
      },
    });
    return res.json({ items });
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

exports.listMyLoanApplications = async (req, res) => {
  try {
    await ensureDefaultLoanProducts(prisma);
    const items = await prisma.loanApplication.findMany({
      where: { userId: req.user?.id },
      orderBy: { submittedAt: "desc" },
      include: loanApplicationInclude,
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

exports.getMyLoanApplication = async (req, res) => {
  try {
    const item = await prisma.loanApplication.findFirst({
      where: {
        id: req.params.applicationId,
        userId: req.user?.id,
      },
      include: loanApplicationInclude,
    });
    if (!item) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Loan application not found." } });
    }

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

exports.getLoanEquityPaymentOptions = async (req, res) => {
  try {
    const application = await getOwnedLoanApplication({
      applicationId: req.params.applicationId,
      userId: req.user?.id,
    });

    return res.json({
      applicationId: application.id,
      currency: application.product.currency,
      methods: LOAN_PAYMENT_METHODS,
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
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

exports.listLoanEquityPayments = async (req, res) => {
  try {
    const application = await getOwnedLoanApplication({
      applicationId: req.params.applicationId,
      userId: req.user?.id,
    });
    return res.json({
      applicationId: application.id,
      equity: serializeLoanApplication(application).equity,
      contributions: serializeLoanApplication(application).equityContributions,
      payments: serializeLoanApplication(application).equityPayments,
    });
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

exports.listMyLoanReminders = async (req, res) => {
  try {
    const items = await prisma.userNotification.findMany({
      where: {
        userId: req.user?.id,
        workspace: "LOANS",
        type: { in: LOAN_REMINDER_TYPES },
        dismissedAt: null,
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    return res.json({ items, unreadCount: await countUnreadLoanReminders(req.user?.id) });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_NOTIFICATION_MODEL_NOT_READY",
          message: "Loan reminder tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listDismissedLoanReminders = async (req, res) => {
  try {
    const items = await prisma.userNotification.findMany({
      where: {
        userId: req.user?.id,
        workspace: "LOANS",
        type: { in: LOAN_REMINDER_TYPES },
        dismissedAt: { not: null },
      },
      orderBy: { dismissedAt: "desc" },
      take: 20,
    });

    return res.json({ items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.markLoanReminderRead = async (req, res) => {
  const parsed = reminderIdSchema.safeParse(req.params || {});
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Reminder id is required." } });
  }

  try {
    const reminder = await getOwnedLoanReminder(parsed.data.notificationId, req.user?.id);
    if (!reminder || reminder.dismissedAt) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Reminder not found." } });
    }

    const item = await prisma.userNotification.update({
      where: { id: reminder.id },
      data: { isRead: true },
    });

    return res.json({ item, unreadCount: await countUnreadLoanReminders(req.user?.id) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.markLoanReminderUnread = async (req, res) => {
  const parsed = reminderIdSchema.safeParse(req.params || {});
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Reminder id is required." } });
  }

  try {
    const reminder = await getOwnedLoanReminder(parsed.data.notificationId, req.user?.id);
    if (!reminder || reminder.dismissedAt) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Reminder not found." } });
    }

    const item = await prisma.userNotification.update({
      where: { id: reminder.id },
      data: { isRead: false },
    });

    return res.json({ item, unreadCount: await countUnreadLoanReminders(req.user?.id) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.dismissLoanReminder = async (req, res) => {
  const parsed = reminderIdSchema.safeParse(req.params || {});
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Reminder id is required." } });
  }

  try {
    const reminder = await getOwnedLoanReminder(parsed.data.notificationId, req.user?.id);
    if (!reminder || reminder.dismissedAt) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Reminder not found." } });
    }

    await prisma.userNotification.update({
      where: { id: reminder.id },
      data: { isRead: true, dismissedAt: new Date() },
    });

    return res.json({ ok: true, unreadCount: await countUnreadLoanReminders(req.user?.id) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.restoreLoanReminder = async (req, res) => {
  const parsed = reminderIdSchema.safeParse(req.params || {});
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Reminder id is required." } });
  }

  try {
    const reminder = await getOwnedLoanReminder(parsed.data.notificationId, req.user?.id);
    if (!reminder || !reminder.dismissedAt) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Reminder not found." } });
    }

    const item = await prisma.userNotification.update({
      where: { id: reminder.id },
      data: { dismissedAt: null, isRead: false },
    });

    return res.json({ item, unreadCount: await countUnreadLoanReminders(req.user?.id) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.markAllLoanRemindersRead = async (req, res) => {
  try {
    await prisma.userNotification.updateMany({
      where: {
        userId: req.user?.id,
        workspace: "LOANS",
        type: { in: LOAN_REMINDER_TYPES },
        dismissedAt: null,
        isRead: false,
      },
      data: { isRead: true },
    });

    return res.json({ ok: true, unreadCount: 0 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.getLoanRepaymentPaymentOptions = async (req, res) => {
  try {
    const installment = await getOwnedInstallment({
      installmentId: req.params.installmentId,
      userId: req.user?.id,
    });

    return res.json({
      installmentId: installment.id,
      applicationId: installment.applicationId,
      currency: installment.application.product.currency || "GBP",
      methods: LOAN_REPAYMENT_PAYMENT_METHODS,
    });
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

exports.createLoanApplicationDraft = async (req, res) => {
  const parsed = draftSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid payload.", details: parsed.error.flatten() },
    });
  }

  try {
    await ensureDefaultLoanProducts(prisma);
    await validateProductAgainstApplication(parsed.data);

    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.loanApplication.create({
        data: {
          userId: req.user?.id,
          productId: parsed.data.productId,
          amountRequested: parsed.data.amountRequested,
          termMonths: parsed.data.termMonths,
          purpose: parsed.data.purpose,
          employmentStatus: cleanNullableText(parsed.data.employmentStatus),
          employerName: cleanNullableText(parsed.data.employerName),
          businessName: cleanNullableText(parsed.data.businessName),
          monthlyIncomeSnapshot:
            parsed.data.monthlyIncomeSnapshot == null ? null : parsed.data.monthlyIncomeSnapshot,
          monthlyExpenseSnapshot:
            parsed.data.monthlyExpenseSnapshot == null ? null : parsed.data.monthlyExpenseSnapshot,
          applicantNote: cleanNullableText(parsed.data.applicantNote),
          status: "DRAFT",
        },
        include: loanApplicationInclude,
      });
      await logUpdate(
        tx,
        created.id,
        "USER",
        "APPLICATION_CREATED",
        "Loan draft created",
        "Application draft created and ready for supporting documents.",
        {
          productId: created.productId,
          amountRequested: created.amountRequested,
          termMonths: created.termMonths,
        }
      );
      return tx.loanApplication.findUnique({
        where: { id: created.id },
        include: loanApplicationInclude,
      });
    });

    return res.status(201).json({ item: serializeLoanApplication(item) });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
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

exports.updateLoanApplication = async (req, res) => {
  const parsed = draftSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid payload.", details: parsed.error.flatten() },
    });
  }

  try {
    const existing = await getMutableApplication({
      applicationId: req.params.applicationId,
      userId: req.user?.id,
    });

    await validateProductAgainstApplication(parsed.data);

    if (existing.productId !== parsed.data.productId && existing.documents.length > 0) {
      throw {
        status: 409,
        code: "PRODUCT_CHANGE_REQUIRES_NEW_DRAFT",
        message: "Create a new application if you want to switch products after uploading documents.",
      };
    }

    const item = await prisma.$transaction(async (tx) => {
      const updated = await tx.loanApplication.update({
        where: { id: existing.id },
        data: {
          productId: parsed.data.productId,
          amountRequested: parsed.data.amountRequested,
          termMonths: parsed.data.termMonths,
          purpose: parsed.data.purpose,
          employmentStatus: cleanNullableText(parsed.data.employmentStatus),
          employerName: cleanNullableText(parsed.data.employerName),
          businessName: cleanNullableText(parsed.data.businessName),
          monthlyIncomeSnapshot:
            parsed.data.monthlyIncomeSnapshot == null ? null : parsed.data.monthlyIncomeSnapshot,
          monthlyExpenseSnapshot:
            parsed.data.monthlyExpenseSnapshot == null ? null : parsed.data.monthlyExpenseSnapshot,
          applicantNote: cleanNullableText(parsed.data.applicantNote),
        },
        include: loanApplicationInclude,
      });
      await logUpdate(
        tx,
        updated.id,
        "USER",
        "APPLICATION_UPDATED",
        "Application details updated",
        "Borrower updated loan request details before admin review.",
        {
          status: updated.status,
          amountRequested: updated.amountRequested,
          termMonths: updated.termMonths,
        }
      );
      return tx.loanApplication.findUnique({
        where: { id: updated.id },
        include: loanApplicationInclude,
      });
    });

    return res.json({ item: serializeLoanApplication(item) });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
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

exports.submitLoanApplication = async (req, res) => {
  try {
    const application = await getMutableApplication({
      applicationId: req.params.applicationId,
      userId: req.user?.id,
    });

    if ((application.documents || []).length === 0) {
      return res.status(400).json({
        error: {
          code: "DOCUMENT_REQUIRED",
          message: "Upload at least one supporting document before submitting your loan application.",
        },
      });
    }

    const item = await prisma.$transaction(async (tx) => {
      const submitted = await tx.loanApplication.update({
        where: { id: application.id },
        data: {
          status: "SUBMITTED",
          submittedAt: new Date(),
        },
        include: loanApplicationInclude,
      });
      await logUpdate(
        tx,
        submitted.id,
        "USER",
        application.status === "MORE_INFO_REQUIRED" ? "CUSTOMER_RESPONSE" : "SUBMITTED",
        application.status === "MORE_INFO_REQUIRED" ? "Customer resubmitted application" : "Application submitted",
        application.status === "MORE_INFO_REQUIRED"
          ? "Customer submitted updated information after admin follow-up."
          : "Application submitted for admin review.",
        { previousStatus: application.status }
      );
      return tx.loanApplication.findUnique({
        where: { id: submitted.id },
        include: loanApplicationInclude,
      });
    });

    return res.json({ item: serializeLoanApplication(item) });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
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

exports.respondToLoanInfoRequest = async (req, res) => {
  const parsed = responseSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Add a clear response note before resubmitting.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const application = await prisma.loanApplication.findFirst({
      where: {
        id: req.params.applicationId,
        userId: req.user?.id,
      },
      include: loanApplicationInclude,
    });

    if (!application) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Loan application not found." } });
    }
    if (application.status !== "MORE_INFO_REQUIRED") {
      return res.status(409).json({
        error: {
          code: "APPLICATION_NOT_WAITING_FOR_RESPONSE",
          message: "This loan application is not currently waiting for a customer response.",
        },
      });
    }

    const item = await prisma.$transaction(async (tx) => {
      await logUpdate(
        tx,
        application.id,
        "USER",
        "CUSTOMER_RESPONSE",
        "Customer provided requested update",
        parsed.data.note,
        { previousStatus: application.status }
      );

      const updated = await tx.loanApplication.update({
        where: { id: application.id },
        data: {
          status: "SUBMITTED",
          submittedAt: new Date(),
        },
        include: loanApplicationInclude,
      });

      await logUpdate(
        tx,
        application.id,
        "SYSTEM",
        "SUBMITTED",
        "Application returned to review queue",
        "Loan application resubmitted after customer follow-up.",
        { previousStatus: application.status, nextStatus: "SUBMITTED" }
      );

      return updated;
    });

    return res.json({ item: serializeLoanApplication(item) });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
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

exports.submitLoanEquityGatewayPayment = async (req, res) => {
  const parsed = gatewayEquitySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid gateway equity payment payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const application = await tx.loanApplication.findFirst({
        where: {
          id: req.params.applicationId,
          userId: req.user?.id,
        },
        include: {
          product: {
            select: {
              id: true,
              currency: true,
              equityRequirementPct: true,
              minimumEquityAmount: true,
            },
          },
          equityContributions: { select: { amount: true } },
          equityPayments: {
            where: { status: { in: ["SUBMITTED", "APPROVED"] } },
            select: { amount: true, status: true, channel: true },
          },
        },
      });

      if (!application) throw { status: 404, code: "NOT_FOUND", message: "Loan application not found." };
      if (!["DRAFT", "SUBMITTED", "MORE_INFO_REQUIRED", "IN_REVIEW"].includes(application.status)) {
        throw { status: 409, code: "APPLICATION_CLOSED", message: "This application is no longer accepting equity payments." };
      }

      await assertNoEquityPaymentConflict(tx, application.id, "GATEWAY");

      const requiredAmount = getEquityRequiredAmount(application);
      const confirmedAmount = getConfirmedEquityAmount(application);
      const remainingAmount = Math.max(requiredAmount - confirmedAmount, 0);
      if (remainingAmount <= 0) {
        throw { status: 409, code: "EQUITY_ALREADY_FUNDED", message: "Required equity has already been funded." };
      }
      if (parsed.data.amount > remainingAmount + 0.01) {
        throw {
          status: 400,
          code: "AMOUNT_EXCEEDS_REQUIRED_EQUITY",
          message: `Amount exceeds the remaining required equity of ${remainingAmount.toFixed(2)}.`,
        };
      }

      const providerRef =
        parsed.data.providerRef || `STRIPE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const payment = await tx.loanEquityPayment.create({
        data: {
          applicationId: application.id,
          userId: req.user?.id,
          amount: parsed.data.amount,
          currency: application.product.currency || "GBP",
          channel: "GATEWAY",
          status: "APPROVED",
          providerRef,
          note: parsed.data.note || null,
          reviewedById: "SYSTEM",
          reviewNote: "Auto-approved via Stripe gateway flow",
          reviewedAt: new Date(),
        },
      });

      const contribution = await tx.loanEquityContribution.create({
        data: {
          applicationId: application.id,
          userId: req.user?.id,
          amount: parsed.data.amount,
          currency: application.product.currency || "GBP",
          channel: "GATEWAY",
          paymentRef: providerRef,
          paidAt: new Date(),
        },
      });

      const updated = await tx.loanApplication.findUnique({
        where: { id: application.id },
        include: loanApplicationInclude,
      });

      return { payment, contribution, application: updated };
    });

    return res.status(201).json({
      status: "PAYMENT_CAPTURED",
      payment: out.payment,
      contribution: out.contribution,
      application: serializeLoanApplication(out.application),
    });
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

exports.submitLoanEquityManualPayment = async (req, res) => {
  const parsed = manualEquitySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid manual equity payment payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const application = await tx.loanApplication.findFirst({
        where: {
          id: req.params.applicationId,
          userId: req.user?.id,
        },
        include: {
          product: {
            select: {
              id: true,
              currency: true,
              equityRequirementPct: true,
              minimumEquityAmount: true,
            },
          },
          equityContributions: { select: { amount: true } },
          equityPayments: {
            where: { status: { in: ["SUBMITTED", "APPROVED"] } },
            select: { amount: true, status: true, channel: true },
          },
        },
      });

      if (!application) throw { status: 404, code: "NOT_FOUND", message: "Loan application not found." };
      if (!["DRAFT", "SUBMITTED", "MORE_INFO_REQUIRED", "IN_REVIEW"].includes(application.status)) {
        throw { status: 409, code: "APPLICATION_CLOSED", message: "This application is no longer accepting equity payments." };
      }

      await assertNoEquityPaymentConflict(tx, application.id, "BANK_TRANSFER");

      const requiredAmount = getEquityRequiredAmount(application);
      const confirmedAmount = getConfirmedEquityAmount(application);
      const remainingAmount = Math.max(requiredAmount - confirmedAmount, 0);
      if (remainingAmount <= 0) {
        throw { status: 409, code: "EQUITY_ALREADY_FUNDED", message: "Required equity has already been funded." };
      }
      if (parsed.data.amount > remainingAmount + 0.01) {
        throw {
          status: 400,
          code: "AMOUNT_EXCEEDS_REQUIRED_EQUITY",
          message: `Amount exceeds the remaining required equity of ${remainingAmount.toFixed(2)}.`,
        };
      }

      return tx.loanEquityPayment.create({
        data: {
          applicationId: application.id,
          userId: req.user?.id,
          amount: parsed.data.amount,
          currency: application.product.currency || "GBP",
          channel: "BANK_TRANSFER",
          status: "SUBMITTED",
          userReference: parsed.data.userReference,
          note: parsed.data.note || null,
          receiptUrl: parsed.data.receiptUrl || null,
        },
      });
    });

    return res.status(201).json({
      status: "PAYMENT_SUBMITTED",
      message: "Equity transfer submitted. Admin confirmation is required.",
      payment: out,
    });
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

exports.submitLoanRepaymentGatewayPayment = async (req, res) => {
  const parsed = gatewayRepaymentSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid gateway repayment payment payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const installment = await tx.loanRepaymentInstallment.findFirst({
        where: {
          id: req.params.installmentId,
          application: {
            userId: req.user?.id,
          },
        },
        include: {
          application: {
            include: {
              product: { select: { id: true, currency: true } },
            },
          },
        },
      });

      if (!installment) throw { status: 404, code: "NOT_FOUND", message: "Loan repayment installment not found." };
      const payment = await applyGatewayRepayment(tx, {
        installment,
        userId: req.user?.id,
        amount: parsed.data.amount,
        providerRef: parsed.data.providerRef,
        note: parsed.data.note,
      });

      const application = await tx.loanApplication.findUnique({
        where: { id: installment.applicationId },
        include: loanApplicationInclude,
      });
      return { payment, application };
    });

    return res.status(201).json({
      status: "PAYMENT_CAPTURED",
      payment: out.payment,
      application: serializeLoanApplication(out.application),
    });
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

exports.submitLoanRepaymentManualPayment = async (req, res) => {
  const parsed = manualRepaymentSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid manual repayment payment payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const payment = await prisma.$transaction(async (tx) => {
      const installment = await tx.loanRepaymentInstallment.findFirst({
        where: {
          id: req.params.installmentId,
          application: {
            userId: req.user?.id,
          },
        },
        include: {
          application: {
            include: {
              product: { select: { currency: true } },
            },
          },
        },
      });

      if (!installment) throw { status: 404, code: "NOT_FOUND", message: "Loan repayment installment not found." };

      const outstandingBefore = roundMoney(
        Math.max(Number(installment.totalDue || 0) - Number(installment.amountPaid || 0), 0)
      );
      if (outstandingBefore <= 0) {
        throw { status: 409, code: "INSTALLMENT_ALREADY_SETTLED", message: "This installment has already been fully settled." };
      }
      if (parsed.data.amount > outstandingBefore + 0.01) {
        throw {
          status: 400,
          code: "AMOUNT_EXCEEDS_INSTALLMENT",
          message: `Amount exceeds the remaining installment balance of ${outstandingBefore.toFixed(2)}.`,
        };
      }

      await assertNoRepaymentPaymentConflict(tx, installment.id, "BANK_TRANSFER");

      return tx.loanRepaymentPayment.create({
        data: {
          applicationId: installment.applicationId,
          installmentId: installment.id,
          userId: req.user?.id,
          amount: parsed.data.amount,
          currency: installment.application.product.currency || "GBP",
          channel: "BANK_TRANSFER",
          status: "SUBMITTED",
          userReference: parsed.data.userReference,
          note: parsed.data.note || null,
          receiptUrl: parsed.data.receiptUrl || null,
        },
      });
    });

    return res.status(201).json({
      status: "PAYMENT_SUBMITTED",
      message: "Repayment transfer submitted. Admin confirmation is required.",
      payment,
    });
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

exports.uploadLoanApplicationDocument = async (req, res) => {
  try {
    const application = await getMutableApplication({
      applicationId: req.params.applicationId,
      userId: req.user?.id,
    });

    const file = req.file;
    const documentType = String(req.body?.documentType || "").toUpperCase();
    if (!file) {
      return res.status(400).json({ error: { code: "FILE_REQUIRED", message: "Select a document to upload." } });
    }
    if (!DOCUMENT_TYPES.has(documentType)) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Select a valid document type before uploading." },
      });
    }
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      return res.status(400).json({
        error: {
          code: "INVALID_FILE_TYPE",
          message: "Only PDF, JPG, PNG, DOC, and DOCX files are allowed.",
        },
      });
    }

    const uploaded = await uploadLoanDocument({
      applicationId: application.id,
      originalName: file.originalname,
      buffer: file.buffer,
      mimeType: file.mimetype,
    });

    const document = await prisma.$transaction(async (tx) => {
      const created = await tx.loanApplicationDocument.create({
        data: {
          applicationId: application.id,
          documentType,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storageKey: uploaded.key,
          storageBucket: uploaded.bucket,
        },
      });
      await logUpdate(
        tx,
        application.id,
        "USER",
        "DOCUMENT_UPLOADED",
        "Supporting document uploaded",
        `${file.originalname} added to the application.`,
        {
          documentType,
          originalName: file.originalname,
        }
      );
      return created;
    });

    return res.status(201).json({
      item: {
        id: document.id,
        documentType: document.documentType,
        originalName: document.originalName,
        mimeType: document.mimeType,
        sizeBytes: Number(document.sizeBytes),
        uploadedAt: document.uploadedAt,
      },
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "LOAN_APPLICATION_MODEL_NOT_READY",
          message: "Loan application tables are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({
      error: {
        code: err?.code || "SERVER_ERROR",
        message: err?.message || "Document upload failed.",
      },
    });
  }
};

exports.deleteLoanApplicationDocument = async (req, res) => {
  try {
    const application = await getMutableApplication({
      applicationId: req.params.applicationId,
      userId: req.user?.id,
    });

    const document = await prisma.loanApplicationDocument.findFirst({
      where: {
        id: req.params.documentId,
        applicationId: application.id,
      },
    });
    if (!document) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Loan document not found." } });
    }

    await prisma.$transaction(async (tx) => {
      await tx.loanApplicationDocument.delete({ where: { id: document.id } });
      await logUpdate(
        tx,
        application.id,
        "USER",
        "DOCUMENT_REMOVED",
        "Supporting document removed",
        `${document.originalName} removed from the application.`,
        {
          documentType: document.documentType,
          originalName: document.originalName,
        }
      );
    });
    return res.json({ ok: true });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
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

exports.downloadLoanApplicationDocument = async (req, res) => {
  try {
    const document = await prisma.loanApplicationDocument.findFirst({
      where: {
        id: req.params.documentId,
        applicationId: req.params.applicationId,
      },
      include: {
        application: {
          select: {
            id: true,
            userId: true,
          },
        },
      },
    });

    if (!document || !document.application) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Loan document not found." } });
    }

    if (req.user?.role !== "ADMIN" && document.application.userId !== req.user?.id) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Access denied." } });
    }

    const out = await openLoanDocument({
      bucket: document.storageBucket,
      key: document.storageKey,
    });

    res.setHeader("Content-Type", out.contentType);
    if (out.contentLength) res.setHeader("Content-Length", String(out.contentLength));
    res.setHeader("Content-Disposition", `inline; filename="${document.originalName.replace(/"/g, "")}"`);
    out.body.pipe(res);
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
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

exports.createLoanTransaction = async (req, res) => {
  try {
    const userId = req.user?.id;
    const applicationId = req.body?.applicationId ? String(req.body.applicationId) : null;
    const installmentId = req.body?.installmentId ? String(req.body.installmentId) : null;
    const type = String(req.body?.type || "").toUpperCase();
    const direction = String(req.body?.direction || "").toUpperCase();
    const amount = Number(req.body?.amount);
    const currency = String(req.body?.currency || "GBP").toUpperCase();
    const reference = req.body?.reference ? String(req.body.reference).trim() : null;
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const metadata = req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : null;

    if (!LOAN_TYPES.has(type)) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid loan transaction type." } });
    }
    if (!DIRECTIONS.has(direction)) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "direction must be DEBIT or CREDIT." } });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "amount must be greater than 0." } });
    }

    const tx = await prisma.loanTransaction.create({
      data: {
        userId,
        applicationId,
        installmentId,
        type,
        direction,
        amount,
        currency,
        reference,
        note,
        metadata,
      },
    });

    return res.status(201).json({ item: tx });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listLoanTransactions = async (req, res) => {
  try {
    const userId = req.user?.id;
    const items = await prisma.loanTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return res.json({ items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
