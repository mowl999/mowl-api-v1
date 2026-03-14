const { z } = require("zod");
const { prisma } = require("../db");

const requestPauseSchema = z.object({
  months: z.number().int().min(1),
  paymentRef: z.string().min(3).optional(),
  note: z.string().max(300).optional(),
});

async function assertPlanOwner(tx, planId, userId) {
  const plan = await tx.plan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      userId: true,
      memberCount: true,
      currentCycleIndex: true,
      currency: true,
      ruleConfig: {
        select: {
          pauseFeatureEnabled: true,
          pauseFeePerMonth: true,
          maxPauseMonths: true,
        },
      },
    },
  });
  if (!plan) throw { status: 404, code: "NOT_FOUND", message: "Plan not found." };
  if (plan.userId !== userId) throw { status: 403, code: "FORBIDDEN", message: "No access to this plan." };
  return plan;
}

async function resolvePauseEligibility(tx, plan, userId) {
  const realMember = await tx.planMember.findFirst({
    where: { planId: plan.id, type: "REAL" },
    select: { position: true },
  });
  const payoutCycleIndex = (realMember?.position ?? 1) - 1;
  const payoutCompleted = plan.currentCycleIndex > payoutCycleIndex;
  const remainingContributionCycles = Math.max(0, plan.memberCount - plan.currentCycleIndex);
  const maxPauseMonths = Number(plan.ruleConfig?.maxPauseMonths || 0);
  const pauseFeePerMonth = Number(plan.ruleConfig?.pauseFeePerMonth || 0);
  const featureEnabled = Boolean(plan.ruleConfig?.pauseFeatureEnabled);
  const maxRequestableMonths = Math.max(0, Math.min(remainingContributionCycles, maxPauseMonths));

  const activePause = await tx.planPause.findFirst({
    where: {
      planId: plan.id,
      userId,
      status: "APPROVED",
      endCycleIndex: { gte: plan.currentCycleIndex },
    },
    orderBy: { createdAt: "desc" },
  });
  const pendingPause = await tx.planPause.findFirst({
    where: {
      planId: plan.id,
      userId,
      status: "SUBMITTED",
    },
    orderBy: { createdAt: "desc" },
  });

  return {
    payoutCycleIndex,
    payoutCompleted,
    remainingContributionCycles,
    maxPauseMonths,
    pauseFeePerMonth,
    featureEnabled,
    maxRequestableMonths,
    hasActivePause: Boolean(activePause),
    activePause,
    hasPendingPause: Boolean(pendingPause),
    pendingPause,
    canRequest:
      featureEnabled &&
      payoutCompleted &&
      remainingContributionCycles > 0 &&
      maxRequestableMonths > 0 &&
      !activePause &&
      !pendingPause,
  };
}

exports.getPauseOptions = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;
    const out = await prisma.$transaction(async (tx) => {
      const plan = await assertPlanOwner(tx, planId, userId);
      const eligibility = await resolvePauseEligibility(tx, plan, userId);
      return { plan, eligibility };
    });

    return res.json({
      planId: out.plan.id,
      currency: out.plan.currency,
      ...out.eligibility,
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.requestPause = async (req, res) => {
  const parsed = requestPauseSchema.safeParse({
    months: Number(req.body?.months),
    paymentRef: req.body?.paymentRef,
    note: req.body?.note,
  });
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid pause request payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const userId = req.user?.id;
    const { planId } = req.params;
    const out = await prisma.$transaction(async (tx) => {
      const plan = await assertPlanOwner(tx, planId, userId);
      const eligibility = await resolvePauseEligibility(tx, plan, userId);

      if (!eligibility.featureEnabled) {
        throw { status: 403, code: "PAUSE_DISABLED", message: "Pause is disabled by admin for this product." };
      }
      if (!eligibility.payoutCompleted) {
        throw {
          status: 403,
          code: "PAUSE_NOT_ELIGIBLE",
          message: "Pause is only available after your payout has happened.",
          details: { payoutCycleIndex: eligibility.payoutCycleIndex, currentCycleIndex: plan.currentCycleIndex },
        };
      }
      if (eligibility.remainingContributionCycles <= 0) {
        throw {
          status: 409,
          code: "NO_OUTSTANDING_CONTRIBUTIONS",
          message: "No outstanding contribution cycles left to pause.",
        };
      }
      if (eligibility.hasActivePause) {
        throw {
          status: 409,
          code: "PAUSE_ALREADY_ACTIVE",
          message: "An active pause already exists for this plan.",
          details: { pauseId: eligibility.activePause.id },
        };
      }
      if (eligibility.hasPendingPause) {
        throw {
          status: 409,
          code: "PAUSE_ALREADY_SUBMITTED",
          message: "A pause request is already pending admin review for this plan.",
          details: { pauseId: eligibility.pendingPause.id },
        };
      }

      const months = parsed.data.months;
      if (months > eligibility.maxRequestableMonths) {
        throw {
          status: 400,
          code: "PAUSE_MONTHS_EXCEEDED",
          message: "Requested pause months exceed your allowable limit.",
          details: {
            requestedMonths: months,
            maxRequestableMonths: eligibility.maxRequestableMonths,
            remainingContributionCycles: eligibility.remainingContributionCycles,
            maxPauseMonths: eligibility.maxPauseMonths,
          },
        };
      }

      const startCycleIndex = plan.currentCycleIndex;
      const endCycleIndex = startCycleIndex + months - 1;
      const feePerMonth = Number(eligibility.pauseFeePerMonth.toFixed(2));
      const totalFee = Number((months * feePerMonth).toFixed(2));
      const paymentRef = parsed.data.paymentRef || `PAUSE-${Date.now()}`;

      const pause = await tx.planPause.create({
        data: {
          planId: plan.id,
          userId,
          startCycleIndex,
          endCycleIndex,
          months,
          feePerMonth,
          totalFee,
          status: "SUBMITTED",
          paymentRef,
          note: parsed.data.note || null,
        },
      });

      return { pause, plan };
    });

    return res.status(201).json({
      status: out.pause.status,
      pause: out.pause,
      message: "Pause request submitted. Admin approval is required.",
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listPauses = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;
    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: { id: true, userId: true },
    });
    if (!plan) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    if (plan.userId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN", message: "No access." } });

    const items = await prisma.planPause.findMany({
      where: { planId, userId },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ planId, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
