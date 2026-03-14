const { prisma } = require("../db");
const {
  getPositionInterestRate,
  applyPayoutPositionInterest,
} = require("./position-interest.service");

async function getLatestBalance(tx, userId) {
  const last = await tx.creditLedger.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return last?.balanceAfter ?? 0;
}

function computeCredits({ amount, creditRatePer10, multiplier }) {
  const base = (Number(amount) / 10) * Number(creditRatePer10 || 1);
  return Number((base * Number(multiplier || 1)).toFixed(2));
}

async function maybeAutoAdvanceCycle(tx, { planId, userId, settledCycleIndex }) {
  const plan = await tx.plan.findUnique({
    where: { id: planId },
    select: {
      id: true,
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

  if (!plan) return { advanced: false, reason: "PLAN_NOT_FOUND" };
  if (plan.currentCycleIndex >= plan.memberCount) return { advanced: false, reason: "PLAN_COMPLETED" };
  if (settledCycleIndex !== plan.currentCycleIndex) return { advanced: false, reason: "NOT_CURRENT_CYCLE" };

  const settled = await tx.contribution.findFirst({
    where: {
      planId: plan.id,
      userId,
      cycleIndex: plan.currentCycleIndex,
      status: { in: ["PAID", "LATE", "PAUSED"] },
    },
    select: { id: true },
  });
  if (!settled) return { advanced: false, reason: "CURRENT_NOT_SETTLED" };

  const existingPayout = await tx.payout.findFirst({
    where: { planId: plan.id, cycleIndex: plan.currentCycleIndex },
    select: { id: true },
  });
  if (existingPayout) return { advanced: false, reason: "CYCLE_ALREADY_CLOSED" };

  const recipientPosition = plan.currentCycleIndex + 1;
  const recipient = await tx.planMember.findFirst({
    where: { planId: plan.id, position: recipientPosition },
    select: { type: true, displayName: true, position: true },
  });
  if (!recipient) return { advanced: false, reason: "RECIPIENT_NOT_FOUND" };

  const basePotAmount = Number((plan.contributionAmount * plan.memberCount).toFixed(2));
  const positionInterestRate = getPositionInterestRate(recipient.position, plan.memberCount, {
    earlyChargePct: plan.ruleConfig?.positionEarlyChargePct,
    lateCompensationPct: plan.ruleConfig?.positionLateCompensationPct,
  });
  const potAmount = applyPayoutPositionInterest(basePotAmount, positionInterestRate);
  const poolDelta = Number((basePotAmount - potAmount).toFixed(2));

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
      return { advanced: false, reason: "PAYOUT_ELIGIBILITY_NOT_MET", requiredCycles, paidCycles };
    }
  }

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
    select: { currentCycleIndex: true },
  });

  await tx.decisionLog.create({
    data: {
      decisionType: "CYCLE_CLOSE",
      userId,
      planId: plan.id,
      inputs: { cycleIndex: plan.currentCycleIndex, basePotAmount, potAmount, positionInterestRate, poolDelta },
      ruleApplied: "AUTO_CLOSE_ON_SETTLED_CONTRIBUTION",
      outcome: { payoutId: payout.id, recipientPosition: recipient.position, status: payout.status },
    },
  });

  return {
    advanced: true,
    payoutId: payout.id,
    closedCycleIndex: payout.cycleIndex,
    nextCycleIndex: updatedPlan.currentCycleIndex,
  };
}

async function settleContribution(tx, { plan, contribution, userId, status, paymentRef, paidAt }) {
  if (!["PAID", "LATE", "MISSED"].includes(status)) {
    throw { status: 400, code: "VALIDATION_ERROR", message: "status must be PAID, LATE, or MISSED." };
  }

  const contrib = await tx.contribution.findUnique({
    where: { id: contribution.id },
    select: {
      id: true,
      planId: true,
      userId: true,
      status: true,
      amount: true,
      cycleIndex: true,
    },
  });

  if (!contrib || contrib.planId !== plan.id || contrib.userId !== userId) {
    throw { status: 404, code: "NOT_FOUND", message: "Contribution not found." };
  }

  if (["PAID", "LATE", "MISSED", "PAUSED"].includes(contrib.status) && contrib.status !== "PENDING") {
    throw { status: 409, code: "ALREADY_CONFIRMED", message: `Contribution already ${contrib.status}.` };
  }

  const rule = await tx.ruleConfig.findUnique({
    where: { id: plan.ruleConfigId },
    select: {
      creditRatePer10: true,
      multiplierOnTime: true,
      multiplierLate: true,
      missedPaymentCredits: true,
      postPayoutMissedPenaltyMultiplier: true,
    },
  });

  if (!rule) throw { status: 500, code: "RULE_CONFIG_MISSING", message: "Rule config not found." };

  if (status === "MISSED") {
    const updated = await tx.contribution.update({
      where: { id: contrib.id },
      data: {
        status: "MISSED",
        paymentRef: paymentRef || null,
        paidAt: null,
        creditsAwarded: 0,
        multiplierApplied: 0,
      },
    });

    const userMember = await tx.planMember.findFirst({
      where: { planId: plan.id, type: "REAL" },
      select: { position: true },
    });
    const userPayoutCycleIndex = (userMember?.position ?? 1) - 1;
    const isPostPayout = contrib.cycleIndex > userPayoutCycleIndex;

    const basePenalty = Number(rule.missedPaymentCredits || -20);
    const postMultiplier = Number(rule.postPayoutMissedPenaltyMultiplier || 2.0);
    const finalPenalty = isPostPayout ? basePenalty * postMultiplier : basePenalty;

    await tx.penalty.create({
      data: {
        userId,
        code: isPostPayout ? "MISSED_CONTRIBUTION_POST_PAYOUT" : "MISSED_CONTRIBUTION",
        creditsDelta: finalPenalty,
      },
    });

    return { updated, creditsAwarded: 0 };
  }

  const multiplier = status === "LATE" ? rule.multiplierLate : rule.multiplierOnTime;
  const creditsAwarded = computeCredits({
    amount: contrib.amount,
    creditRatePer10: rule.creditRatePer10,
    multiplier,
  });

  const prevBalance = await getLatestBalance(tx, userId);
  const newBalance = prevBalance + creditsAwarded;

  const updated = await tx.contribution.update({
    where: { id: contrib.id },
    data: {
      status,
      paymentRef: paymentRef || null,
      paidAt: paidAt ? new Date(paidAt) : new Date(),
      creditsAwarded,
      multiplierApplied: Number(multiplier || 1),
    },
  });

  await tx.creditLedger.create({
    data: {
      userId,
      delta: creditsAwarded,
      balanceAfter: newBalance,
      reason: status === "LATE" ? "CONTRIBUTION_LATE" : "CONTRIBUTION_PAID",
      referenceId: updated.id,
    },
  });

  const autoCycle = await maybeAutoAdvanceCycle(tx, {
    planId: plan.id,
    userId,
    settledCycleIndex: contrib.cycleIndex,
  });

  return { updated, creditsAwarded, newBalance, autoCycle };
}

module.exports = { settleContribution };
