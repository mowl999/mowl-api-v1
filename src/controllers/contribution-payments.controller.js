const { z } = require("zod");
const { prisma } = require("../db");
const { settleContribution } = require("../services/contribution-settlement.service");

function ensurePaymentModel(res) {
  if (!prisma.contributionPayment) {
    res.status(500).json({
      error: {
        code: "PAYMENT_MODEL_NOT_READY",
        message:
          "Payment model is not ready. Run Prisma migrate + generate, then restart API.",
      },
    });
    return false;
  }
  return true;
}

async function assertPlanOwner(tx, planId, userId) {
  const plan = await tx.plan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      userId: true,
      currency: true,
      ruleConfigId: true,
    },
  });
  if (!plan) throw { status: 404, code: "NOT_FOUND", message: "Plan not found." };
  if (plan.userId !== userId) throw { status: 403, code: "FORBIDDEN", message: "No access to this plan." };
  return plan;
}

async function assertContributionOwner(tx, contributionId, planId, userId) {
  const contribution = await tx.contribution.findUnique({
    where: { id: contributionId },
    select: {
      id: true,
      planId: true,
      userId: true,
      status: true,
      amount: true,
      cycleIndex: true,
    },
  });
  if (!contribution || contribution.planId !== planId || contribution.userId !== userId) {
    throw { status: 404, code: "NOT_FOUND", message: "Contribution not found." };
  }
  return contribution;
}

async function assertNoPaymentConflict(tx, contributionId, requestedChannel) {
  const active = await tx.contributionPayment.findFirst({
    where: {
      contributionId,
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
      message: `Payment method is locked to ${active.channel} for this contribution.`,
      details: { activePaymentId: active.id, activeChannel: active.channel, activeStatus: active.status },
    };
  }

  if (active.status === "SUBMITTED") {
    throw {
      status: 409,
      code: "PAYMENT_ALREADY_SUBMITTED",
      message: "A payment submission is already pending review for this contribution.",
      details: { activePaymentId: active.id, activeChannel: active.channel },
    };
  }

  throw {
    status: 409,
    code: "CONTRIBUTION_ALREADY_PAID",
    message: "This contribution is already paid.",
    details: { activePaymentId: active.id, activeChannel: active.channel },
  };
}

const gatewaySchema = z.object({
  providerRef: z.string().min(3).optional(),
  note: z.string().max(300).optional(),
});

const manualSchema = z.object({
  userReference: z.string().min(3),
  note: z.string().max(300).optional(),
  receiptUrl: z.string().url().optional(),
});

exports.submitGatewayPayment = async (req, res) => {
  if (!ensurePaymentModel(res)) return;
  const userId = req.user?.id;
  const { planId, contributionId } = req.params;
  const parsed = gatewaySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid gateway payment payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const plan = await assertPlanOwner(tx, planId, userId);
      const contribution = await assertContributionOwner(tx, contributionId, plan.id, userId);
      await assertNoPaymentConflict(tx, contribution.id, "GATEWAY");

      if (contribution.status !== "PENDING") {
        throw {
          status: 409,
          code: "CONTRIBUTION_NOT_PENDING",
          message: "Only pending contributions can be paid.",
        };
      }

      const providerRef = parsed.data.providerRef || `GW-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const payment = await tx.contributionPayment.create({
        data: {
          contributionId: contribution.id,
          planId: plan.id,
          userId,
          amount: contribution.amount,
          currency: plan.currency,
          channel: "GATEWAY",
          status: "APPROVED",
          providerRef,
          note: parsed.data.note || null,
          reviewedById: "SYSTEM",
          reviewNote: "Auto-approved via gateway",
          reviewedAt: new Date(),
        },
      });

      const settled = await settleContribution(tx, {
        plan,
        contribution,
        userId,
        status: "PAID",
        paymentRef: providerRef,
      });

      return { payment, contribution: settled.updated };
    });

    return res.status(201).json({
      status: "PAYMENT_CAPTURED",
      payment: {
        id: out.payment.id,
        channel: out.payment.channel,
        status: out.payment.status,
        providerRef: out.payment.providerRef,
        reviewedAt: out.payment.reviewedAt,
      },
      contribution: {
        id: out.contribution.id,
        cycleIndex: out.contribution.cycleIndex,
        status: out.contribution.status,
        amount: out.contribution.amount,
        paymentRef: out.contribution.paymentRef,
        paidAt: out.contribution.paidAt,
      },
    });
  } catch (err) {
    if (err?.code === "P2021") {
      return res.status(500).json({
        error: {
          code: "PAYMENT_TABLE_NOT_READY",
          message:
            "ContributionPayment table not found. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.submitManualTransfer = async (req, res) => {
  if (!ensurePaymentModel(res)) return;
  const userId = req.user?.id;
  const { planId, contributionId } = req.params;
  const parsed = manualSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid manual transfer payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const plan = await assertPlanOwner(tx, planId, userId);
      const contribution = await assertContributionOwner(tx, contributionId, plan.id, userId);
      await assertNoPaymentConflict(tx, contribution.id, "BANK_TRANSFER");

      if (contribution.status !== "PENDING") {
        throw {
          status: 409,
          code: "CONTRIBUTION_NOT_PENDING",
          message: "Only pending contributions can be submitted for manual review.",
        };
      }
      const payment = await tx.contributionPayment.create({
        data: {
          contributionId: contribution.id,
          planId: plan.id,
          userId,
          amount: contribution.amount,
          currency: plan.currency,
          channel: "BANK_TRANSFER",
          status: "SUBMITTED",
          userReference: parsed.data.userReference,
          note: parsed.data.note || null,
          receiptUrl: parsed.data.receiptUrl || null,
        },
      });

      return payment;
    });

    return res.status(201).json({
      status: "PAYMENT_SUBMITTED",
      message: "Transfer submitted. Admin review is required and may take up to 24 hours.",
      payment: {
        id: out.id,
        channel: out.channel,
        status: out.status,
        userReference: out.userReference,
        submittedAt: out.submittedAt,
      },
    });
  } catch (err) {
    if (err?.code === "P2021") {
      return res.status(500).json({
        error: {
          code: "PAYMENT_TABLE_NOT_READY",
          message:
            "ContributionPayment table not found. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listContributionPayments = async (req, res) => {
  if (!ensurePaymentModel(res)) return;
  const userId = req.user?.id;
  const { planId, contributionId } = req.params;
  try {
    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: { id: true, userId: true },
    });
    if (!plan) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    if (plan.userId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN", message: "No access." } });

    const items = await prisma.contributionPayment.findMany({
      where: { contributionId, planId, userId },
      orderBy: { submittedAt: "desc" },
      select: {
        id: true,
        channel: true,
        status: true,
        amount: true,
        currency: true,
        providerRef: true,
        userReference: true,
        note: true,
        reviewNote: true,
        submittedAt: true,
        reviewedAt: true,
      },
    });
    return res.json({ contributionId, items });
  } catch (err) {
    if (err?.code === "P2021") {
      return res.status(500).json({
        error: {
          code: "PAYMENT_TABLE_NOT_READY",
          message:
            "ContributionPayment table not found. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
