const { prisma } = require("../db");
const {
  getPositionInterestRate,
  applyPayoutPositionInterest,
} = require("../services/position-interest.service");

async function assertPlanOwner(tx, planId, userId) {
  const plan = await tx.plan.findUnique({
    where: { id: planId },
    select: {
      id: true,
      userId: true,
      memberCount: true,
      contributionAmount: true,
      feePoolAmount: true,
      currency: true,
      currentCycleIndex: true,
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

async function getRecipientForCycle(tx, planId, cycleIndex) {
  const recipientPosition = cycleIndex + 1;

  const member = await tx.planMember.findFirst({
    where: { planId, position: recipientPosition },
    select: { type: true, displayName: true, position: true },
  });

  if (!member) {
    throw { status: 500, code: "RECIPIENT_NOT_FOUND", message: "Recipient not found for this cycle." };
  }
  return member;
}

// POST /v1/plans/:planId/cycles/close
exports.closeCycle = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    const requireUserPaid = process.env.REQUIRE_USER_PAID_TO_CLOSE_CYCLE === "true";

    const out = await prisma.$transaction(async (tx) => {
      const plan = await assertPlanOwner(tx, planId, userId);

      if (plan.currentCycleIndex >= plan.memberCount) {
        throw { status: 409, code: "PLAN_COMPLETED", message: "Plan cycles already completed." };
      }

      // prevent duplicate payout for this cycle
      const existing = await tx.payout.findFirst({
        where: { planId: plan.id, cycleIndex: plan.currentCycleIndex },
        select: { id: true },
      });
      if (existing) {
        throw { status: 409, code: "CYCLE_ALREADY_CLOSED", message: "This cycle already has a payout." };
      }

      // Optional: enforce only REAL user has PAID/LATE contribution before closing cycle
      if (requireUserPaid) {
        const paid = await tx.contribution.findFirst({
          where: {
            planId: plan.id,
            userId,
            cycleIndex: plan.currentCycleIndex,
            status: { in: ["PAID", "LATE", "PAUSED"] },
          },
          select: { id: true },
        });

        if (!paid) {
          throw {
            status: 403,
            code: "USER_CONTRIBUTION_NOT_PAID",
            message: "Confirm your contribution as PAID/LATE before closing the cycle.",
          };
        }
      }

      const recipient = await getRecipientForCycle(tx, plan.id, plan.currentCycleIndex);
      const basePotAmount = Number((plan.contributionAmount * plan.memberCount).toFixed(2));
      const positionInterestRate = getPositionInterestRate(recipient.position, plan.memberCount, {
        earlyChargePct: plan.ruleConfig?.positionEarlyChargePct,
        lateCompensationPct: plan.ruleConfig?.positionLateCompensationPct,
      });
      const potAmount = applyPayoutPositionInterest(basePotAmount, positionInterestRate);
      const poolDelta = Number((basePotAmount - potAmount).toFixed(2));

      // Enforce payout eligibility for real-user recipient:
      // user must have PAID/LATE contributions for every cycle up to payout cycle.
      if (recipient.type === "REAL") {
        const requiredCycles = plan.currentCycleIndex + 1;
        const paidCycles = await tx.contribution.count({
          where: {
            planId: plan.id,
            userId,
            cycleIndex: { lte: plan.currentCycleIndex },
            status: { in: ["PAID", "LATE"] },
          },
        });

        if (paidCycles < requiredCycles) {
          throw {
            status: 403,
            code: "PAYOUT_ELIGIBILITY_NOT_MET",
            message: "Payout is blocked until all contributions up to your payout month are PAID/LATE.",
            details: { requiredCycles, paidCycles },
          };
        }
      }

      // Virtual recipients are auto-marked SENT to avoid manual payout to system members
      const isVirtual = recipient.type === "VIRTUAL";

      const payout = await tx.payout.create({
        data: {
          planId: plan.id,
          cycleIndex: plan.currentCycleIndex,
          recipientPosition: recipient.position,
          recipientType: recipient.type,
          recipientName: recipient.displayName,
          amount: potAmount,
          currency: plan.currency,
          status: isVirtual ? "SENT" : "PENDING",
          sentAt: isVirtual ? new Date() : null,
          note: isVirtual ? "Auto-sent (virtual member)" : null,
        },
      });

      const updatedPlan = await tx.plan.update({
        where: { id: plan.id },
        data: {
          currentCycleIndex: plan.currentCycleIndex + 1,
          feePoolAmount: Number((Number(plan.feePoolAmount || 0) + poolDelta).toFixed(2)),
        },
      });

      // If you have DecisionLog, keep it. If not, delete this block.
      await tx.decisionLog.create({
        data: {
          decisionType: "CYCLE_CLOSE",
          userId,
          planId: plan.id,
          inputs: { cycleIndex: plan.currentCycleIndex, basePotAmount, potAmount, positionInterestRate, poolDelta },
          ruleApplied: "ROSCA_PAYOUT_POSITION = cycleIndex + 1",
          outcome: { payoutId: payout.id, recipientPosition: recipient.position, status: payout.status },
        },
      });

      return { payout, nextCycleIndex: updatedPlan.currentCycleIndex };
    });

    return res.status(201).json({
      status: "CYCLE_CLOSED",
      planId,
      payout: {
        id: out.payout.id,
        cycleIndex: out.payout.cycleIndex,
        amount: out.payout.amount,
        currency: out.payout.currency,
        recipientPosition: out.payout.recipientPosition,
        recipientType: out.payout.recipientType,
        recipientName: out.payout.recipientName,
        status: out.payout.status,
        sentAt: out.payout.sentAt,
        note: out.payout.note,
      },
      nextCycleIndex: out.nextCycleIndex,
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

// GET /v1/plans/:planId/payouts
exports.listPayouts = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: { id: true, userId: true, currency: true },
    });

    if (!plan) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    if (plan.userId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN", message: "No access." } });

    const items = await prisma.payout.findMany({
      where: { planId },
      orderBy: [{ cycleIndex: "asc" }],
      select: {
        id: true,
        cycleIndex: true,
        amount: true,
        currency: true,
        recipientPosition: true,
        recipientType: true,
        recipientName: true,
        status: true,
        sentAt: true,
        reference: true,
        note: true,
        createdAt: true,
      },
    });

    return res.json({ planId, currency: plan.currency, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
