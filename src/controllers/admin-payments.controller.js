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

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reviewNote: z.string().max(300).optional(),
  paymentRef: z.string().min(3).optional(),
});

exports.listPayments = async (req, res) => {
  if (!ensurePaymentModel(res)) return;
  try {
    const status = String(req.query.status || "SUBMITTED").toUpperCase();
    const where = status === "ALL" ? {} : { status };

    const items = await prisma.contributionPayment.findMany({
      where,
      orderBy: { submittedAt: "desc" },
      take: 200,
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
        reviewedById: true,
        user: { select: { id: true, email: true, fullName: true } },
        contribution: {
          select: { id: true, cycleIndex: true, status: true, paymentRef: true, paidAt: true },
        },
        plan: { select: { id: true, name: true } },
      },
    });

    return res.json({ items });
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

exports.reviewPayment = async (req, res) => {
  if (!ensurePaymentModel(res)) return;
  const adminId = req.user?.id || "ADMIN";
  const { paymentId } = req.params;

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
    const out = await prisma.$transaction(async (tx) => {
      const payment = await tx.contributionPayment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          status: true,
          channel: true,
          contributionId: true,
          planId: true,
          userId: true,
          userReference: true,
          providerRef: true,
        },
      });

      if (!payment) throw { status: 404, code: "NOT_FOUND", message: "Payment submission not found." };
      if (payment.status !== "SUBMITTED") {
        throw { status: 409, code: "ALREADY_REVIEWED", message: "Payment submission already reviewed." };
      }

      if (parsed.data.decision === "REJECT") {
        const rejected = await tx.contributionPayment.update({
          where: { id: payment.id },
          data: {
            status: "REJECTED",
            reviewedById: adminId,
            reviewedAt: new Date(),
            reviewNote: parsed.data.reviewNote || "Rejected by admin",
          },
        });
        return { payment: rejected, contribution: null };
      }

      const plan = await tx.plan.findUnique({
        where: { id: payment.planId },
        select: { id: true, userId: true, ruleConfigId: true },
      });
      const contribution = await tx.contribution.findUnique({
        where: { id: payment.contributionId },
        select: { id: true, userId: true, planId: true, status: true, amount: true, cycleIndex: true },
      });

      if (!plan || !contribution || contribution.planId !== plan.id || contribution.userId !== payment.userId) {
        throw { status: 404, code: "NOT_FOUND", message: "Contribution context not found." };
      }
      if (contribution.status !== "PENDING") {
        throw {
          status: 409,
          code: "CONTRIBUTION_ALREADY_SETTLED",
          message: `Contribution already ${contribution.status}.`,
          details: {
            contributionId: contribution.id,
            currentStatus: contribution.status,
          },
        };
      }

      const paymentRef = parsed.data.paymentRef || payment.userReference || payment.providerRef || `ADMIN-${Date.now()}`;
      const settled = await settleContribution(tx, {
        plan,
        contribution,
        userId: payment.userId,
        status: "PAID",
        paymentRef,
      });

      const approved = await tx.contributionPayment.update({
        where: { id: payment.id },
        data: {
          status: "APPROVED",
          reviewedById: adminId,
          reviewedAt: new Date(),
          reviewNote: parsed.data.reviewNote || "Approved by admin",
        },
      });

      return { payment: approved, contribution: settled.updated };
    });

    return res.json({
      status: out.payment.status,
      payment: out.payment,
      contribution: out.contribution,
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
