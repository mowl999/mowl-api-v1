const { prisma } = require("../db");
const {
  getPositionInterestRate,
  applyPositionInterest,
  applyPayoutPositionInterest,
} = require("../services/position-interest.service");

exports.getPlanSummary = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: {
        id: true,
        userId: true,
        name: true,
        memberCount: true,
        contributionAmount: true,
        currency: true,
        currentCycleIndex: true,
        assignedPosition: true,
        status: true,
        createdAt: true,
        ruleConfig: {
          select: {
            positionEarlyChargePct: true,
            positionLateCompensationPct: true,
          },
        },
      },
    });

    if (!plan) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    if (plan.userId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN", message: "No access." } });

    const realMember = await prisma.planMember.findFirst({
      where: { planId: plan.id, type: "REAL" },
      select: { position: true, displayName: true },
    });

    const userPayoutCycleIndex = (realMember?.position ?? 1) - 1;
    const position = realMember?.position ?? 1;
    const positionInterestRate = getPositionInterestRate(position, plan.memberCount, {
      earlyChargePct: plan.ruleConfig?.positionEarlyChargePct,
      lateCompensationPct: plan.ruleConfig?.positionLateCompensationPct,
    });
    const effectiveContributionAmount = applyPositionInterest(plan.contributionAmount, positionInterestRate);
    const alreadyPaid = plan.currentCycleIndex > userPayoutCycleIndex;

    const nextRecipientPosition = plan.currentCycleIndex + 1;
    const nextRecipient = await prisma.planMember.findFirst({
      where: { planId: plan.id, position: nextRecipientPosition },
      select: { type: true, displayName: true, position: true },
    });

    const payoutCount = await prisma.payout.count({ where: { planId: plan.id } });
    const isCompleted = plan.currentCycleIndex >= plan.memberCount;

    return res.json({
      plan: {
        id: plan.id,
        name: plan.name,
        status: isCompleted ? "COMPLETED" : plan.status,
        memberCount: plan.memberCount,
        contributionAmount: plan.contributionAmount,
        effectiveContributionAmount,
        positionInterestRate,
        currency: plan.currency,
        currentCycleIndex: plan.currentCycleIndex,
        createdAt: plan.createdAt,
      },
      you: {
        displayName: realMember?.displayName || "You",
        position: realMember?.position ?? null,
        payoutCycleIndex: userPayoutCycleIndex,
        alreadyPaid,
      },
      nextPayout: isCompleted
        ? null
        : {
            cycleIndex: plan.currentCycleIndex,
            recipientPosition: nextRecipient?.position ?? nextRecipientPosition,
            recipientType: nextRecipient?.type ?? null,
            recipientName: nextRecipient?.displayName ?? null,
            potAmount: applyPayoutPositionInterest(plan.memberCount * plan.contributionAmount, positionInterestRate),
          },
      stats: { payoutsCreated: payoutCount },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
