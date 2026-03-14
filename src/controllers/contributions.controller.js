const { prisma } = require("../db");
const { settleContribution } = require("../services/contribution-settlement.service");
const { getPositionInterestRate, applyPositionInterest } = require("../services/position-interest.service");

async function assertPlanOwner(tx, planId, userId) {
  const plan = await tx.plan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      userId: true,
      contributionAmount: true,
      memberCount: true,
      currency: true,
      currentCycleIndex: true,
      ruleConfigId: true,
      ruleConfig: {
        select: {
          positionEarlyChargePct: true,
          positionLateCompensationPct: true,
        },
      },
    },
  });

  if (!plan) throw { status: 404, code: "NOT_FOUND", message: "Plan not found." };
  if (plan.userId !== userId) throw { status: 403, code: "FORBIDDEN", message: "No access to this plan." };

  return plan;
}

// 1) Create a PENDING contribution for the current cycle (manual mode)
exports.createContribution = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    const result = await prisma.$transaction(async (tx) => {
      const plan = await assertPlanOwner(tx, planId, userId);

      // ensure no duplicate for same cycle
      const existing = await tx.contribution.findFirst({
        where: { planId: plan.id, userId, cycleIndex: plan.currentCycleIndex },
        select: { id: true, status: true },
      });

      if (existing) {
        if (existing.status === "PAUSED") {
          throw {
            status: 409,
            code: "CONTRIBUTION_PAUSED",
            message: "This cycle is paused. Contribution is not required for the pause period.",
            details: existing,
          };
        }
        throw {
          status: 409,
          code: "CONTRIBUTION_EXISTS",
          message: "Contribution already exists for this cycle.",
          details: existing,
        };
      }

      const realMember = await tx.planMember.findFirst({
        where: { planId: plan.id, type: "REAL" },
        select: { position: true },
      });
      const userPosition = realMember?.position ?? 1;
      const interestRate = getPositionInterestRate(userPosition, plan.memberCount, {
        earlyChargePct: plan.ruleConfig?.positionEarlyChargePct,
        lateCompensationPct: plan.ruleConfig?.positionLateCompensationPct,
      });
      const amountDue = applyPositionInterest(plan.contributionAmount, interestRate);

      const c = await tx.contribution.create({
        data: {
          planId: plan.id,
          userId,
          amount: amountDue,
          cycleIndex: plan.currentCycleIndex,
          status: "PENDING",
          creditsAwarded: 0,
          multiplierApplied: 0,
          paymentRef: null,
          paidAt: null,
        },
      });

      return { plan, contribution: c };
    });

    return res.status(201).json({
      planId: result.plan.id,
      cycleIndex: result.plan.currentCycleIndex,
      contribution: {
        id: result.contribution.id,
        amount: result.contribution.amount,
        currency: result.plan.currency,
        status: result.contribution.status,
        createdAt: result.contribution.createdAt,
      },
      nextStep: "Confirm as PAID or MISSED using PATCH /v1/plans/:planId/contributions/:id/confirm",
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

// 2) List contributions for a plan (optionally filter by cycleIndex)
exports.listContributions = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;
    const cycleIndex = req.query.cycleIndex != null ? Number(req.query.cycleIndex) : null;

    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: { id: true, userId: true, currency: true },
    });

    if (!plan) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    if (plan.userId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN", message: "No access." } });

    const where = { planId };
    if (cycleIndex != null && !Number.isNaN(cycleIndex)) where.cycleIndex = cycleIndex;

    const items = await prisma.contribution.findMany({
      where,
      orderBy: [{ cycleIndex: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        cycleIndex: true,
        amount: true,
        status: true,
        creditsAwarded: true,
        multiplierApplied: true,
        paymentRef: true,
        paidAt: true,
        createdAt: true,
      },
    });

    return res.json({ planId, currency: plan.currency, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

// 3) Manual confirm contribution as PAID / LATE / MISSED
exports.confirmContribution = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId, contributionId } = req.params;
    const { status, paymentRef, paidAt } = req.body;

    if (!["PAID", "LATE", "MISSED"].includes(status)) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "status must be one of PAID, LATE, MISSED." },
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const plan = await assertPlanOwner(tx, planId, userId);

      const settled = await settleContribution(tx, {
        plan,
        contribution: { id: contributionId },
        userId,
        status,
        paymentRef,
        paidAt,
      });

      return { plan, ...settled };
    });

    return res.json({
      planId: result.plan.id,
      cycleIndex: result.updated.cycleIndex,
      contribution: {
        id: result.updated.id,
        status: result.updated.status,
        amount: result.updated.amount,
        creditsAwarded: result.updated.creditsAwarded,
        multiplierApplied: result.updated.multiplierApplied,
        paymentRef: result.updated.paymentRef,
        paidAt: result.updated.paidAt,
      },
      creditImpact:
        result.updated.status === "MISSED"
          ? { creditsAwarded: 0, note: "Credit score does not decrease; penalty affects trust score." }
          : { creditsAwarded: result.creditsAwarded, balanceAfter: result.newBalance },
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
