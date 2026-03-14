const { z } = require("zod");
const { prisma } = require("../db");
const { getUserTrustProfile } = require("../services/trust-score.service");

const targetSchema = z.object({
  targetPosition: z.number().int().positive(),
});

async function buildSwapQuote({ userId, planId, targetPosition }) {
  const plan = await prisma.plan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      name: true,
      userId: true,
      memberCount: true,
      contributionAmount: true,
      assignedPosition: true,
      swapsUsed: true,
      ruleConfigId: true,
      currentCycleIndex: true,
    },
  });

  if (!plan) throw { status: 404, code: "NOT_FOUND", message: "Plan not found." };
  if (plan.userId !== userId) throw { status: 403, code: "FORBIDDEN", message: "No access to this plan." };

  const toPos = Number(targetPosition);
  if (!Number.isInteger(toPos) || toPos < 1 || toPos > plan.memberCount) {
    throw {
      status: 400,
      code: "VALIDATION_ERROR",
      message: `targetPosition must be an integer between 1 and ${plan.memberCount}.`,
    };
  }

  const fromPos = plan.assignedPosition;
  if (toPos >= fromPos) {
    throw {
      status: 400,
      code: "INVALID_TARGET_POSITION",
      message: "Target position must be earlier than your current position.",
      details: { fromPosition: fromPos, targetPosition: toPos },
    };
  }

  const minAllowedTarget = plan.currentCycleIndex + 1;
  if (toPos < minAllowedTarget) {
    throw {
      status: 400,
      code: "PAYOUT_WINDOW_PASSED",
      message: "Target position month has already passed.",
      details: { minAllowedTarget, targetPosition: toPos },
    };
  }

  if (plan.currentCycleIndex >= fromPos) {
    throw {
      status: 409,
      code: "PAYOUT_ALREADY_REACHED",
      message: "Swap request is not allowed because your payout month has already been reached.",
    };
  }

  const rule = await prisma.ruleConfig.findUnique({
    where: { id: plan.ruleConfigId },
    select: {
      version: true,
      swapFactor: true,
      swapDiscountRate: true,
      maxSwapsPerPlan: true,
      feeFloorAmount: true,
    },
  });
  if (!rule) throw { status: 500, code: "RULE_CONFIG_MISSING", message: "Rule config for plan not found." };

  if (plan.swapsUsed >= rule.maxSwapsPerPlan) {
    throw {
      status: 403,
      code: "SWAP_LIMIT_REACHED",
      message: "Maximum swaps reached for this plan.",
      details: { maxSwapsPerPlan: rule.maxSwapsPerPlan, swapsUsed: plan.swapsUsed },
    };
  }

  const existingPending = await prisma.swap.findFirst({
    where: { planId: plan.id, userId, status: "SUBMITTED" },
    select: { id: true, toPosition: true, createdAt: true },
  });
  if (existingPending) {
    throw {
      status: 409,
      code: "SWAP_ALREADY_SUBMITTED",
      message: "You already have a pending swap request for this plan.",
      details: { swapId: existingPending.id, toPosition: existingPending.toPosition },
    };
  }

  const trust = await getUserTrustProfile(prisma, userId, {
    baseLimitPct: Number(0.6),
  });
  const trustScore = trust.trustScore;
  const level = trust.trustLevel;
  const creditScore = trust.creditScore;
  if (level === "LOW") {
    throw {
      status: 403,
      code: "SWAP_NOT_ALLOWED",
      message: "Swap not allowed for your current trust level.",
      details: { trustLevel: level, trustScore: Number(trustScore.toFixed(2)) },
    };
  }

  const steps = fromPos - toPos;
  const baseFeeAmount = steps * Number(rule.swapFactor);
  const discountAmount = creditScore * Number(rule.swapDiscountRate) * Number(plan.contributionAmount);
  const effectiveFeeAmount = Math.max(Number(rule.feeFloorAmount || 0), baseFeeAmount - discountAmount);

  return {
    plan,
    rule,
    userMetrics: {
      creditScore,
      trustScore: Number(trustScore.toFixed(2)),
      trustLevel: level,
    },
    quote: {
      fromPosition: fromPos,
      toPosition: toPos,
      steps,
      feeCharged: Number(effectiveFeeAmount.toFixed(2)),
      baseFeeAmount: Number(baseFeeAmount.toFixed(2)),
      discountAmount: Number(discountAmount.toFixed(2)),
      oldPayoutCycleIndex: fromPos - 1,
      newPayoutCycleIndex: toPos - 1,
    },
  };
}

exports.swapQuote = async (req, res) => {
  try {
    const parsed = targetSchema.safeParse({
      targetPosition: Number(req.body?.targetPosition),
    });
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "targetPosition must be a positive integer." },
      });
    }

    const out = await buildSwapQuote({
      userId: req.user?.id,
      planId: req.params.planId,
      targetPosition: parsed.data.targetPosition,
    });

    await prisma.decisionLog.create({
      data: {
        decisionType: "SWAP_QUOTE",
        userId: req.user.id,
        planId: out.plan.id,
        inputs: {
          fromPos: out.quote.fromPosition,
          toPos: out.quote.toPosition,
          steps: out.quote.steps,
          creditScore: out.userMetrics.creditScore,
          trustScore: out.userMetrics.trustScore,
          ruleVersion: out.rule.version,
        },
        ruleApplied: "SWAP_REQUEST_QUOTE_V2",
        outcome: {
          feeCharged: out.quote.feeCharged,
          baseFeeAmount: out.quote.baseFeeAmount,
          discountAmount: out.quote.discountAmount,
        },
      },
    });

    return res.json({
      planId: out.plan.id,
      fromPosition: out.quote.fromPosition,
      toPosition: out.quote.toPosition,
      steps: out.quote.steps,
      feeCharged: out.quote.feeCharged,
      payoutImpact: {
        oldPayoutCycleIndex: out.quote.oldPayoutCycleIndex,
        newPayoutCycleIndex: out.quote.newPayoutCycleIndex,
      },
      userMetrics: {
        trustLevel: out.userMetrics.trustLevel,
        trustScore: out.userMetrics.trustScore,
      },
      canRequest: true,
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.requestSwap = async (req, res) => {
  try {
    const parsed = targetSchema.safeParse({
      targetPosition: Number(req.body?.targetPosition),
    });
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "targetPosition must be a positive integer." },
      });
    }

    const out = await buildSwapQuote({
      userId: req.user?.id,
      planId: req.params.planId,
      targetPosition: parsed.data.targetPosition,
    });

    const swap = await prisma.swap.create({
      data: {
        planId: out.plan.id,
        userId: req.user.id,
        fromPosition: out.quote.fromPosition,
        toPosition: out.quote.toPosition,
        steps: out.quote.steps,
        feeCharged: out.quote.feeCharged,
        status: "SUBMITTED",
      },
    });

    await prisma.decisionLog.create({
      data: {
        decisionType: "SWAP_REQUEST",
        userId: req.user.id,
        planId: out.plan.id,
        inputs: {
          swapId: swap.id,
          fromPos: out.quote.fromPosition,
          toPos: out.quote.toPosition,
          steps: out.quote.steps,
        },
        ruleApplied: "SWAP_REQUEST_SUBMIT_V1",
        outcome: { status: "SUBMITTED", feeCharged: out.quote.feeCharged },
      },
    });

    return res.status(201).json({
      status: swap.status,
      swap: {
        id: swap.id,
        planId: swap.planId,
        fromPosition: swap.fromPosition,
        toPosition: swap.toPosition,
        steps: swap.steps,
        feeCharged: swap.feeCharged,
        createdAt: swap.createdAt,
      },
      message: "Swap request submitted for admin review.",
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listMySwaps = async (req, res) => {
  try {
    const { planId } = req.params;
    const userId = req.user?.id;

    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: { id: true, userId: true },
    });
    if (!plan) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    if (plan.userId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN", message: "No access." } });

    const items = await prisma.swap.findMany({
      where: { planId, userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        fromPosition: true,
        toPosition: true,
        steps: true,
        feeCharged: true,
        status: true,
        reviewNote: true,
        reviewedAt: true,
        createdAt: true,
      },
    });

    return res.json({ items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.executeSwap = async (req, res) => {
  return res.status(403).json({
    error: {
      code: "ADMIN_APPROVAL_REQUIRED",
      message: "Direct swap execution is disabled. Submit swap request for admin approval.",
    },
  });
};
