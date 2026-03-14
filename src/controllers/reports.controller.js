const { prisma } = require("../db");

function resolveRangeStart(range) {
  const now = new Date();
  if (range === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (range === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (range === "90d") return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return null;
}

exports.getMyContributionsReport = async (req, res) => {
  try {
    const userId = req.user?.id;
    const range = String(req.query.range || "30d").toLowerCase();
    const planId = req.query.planId ? String(req.query.planId) : null;

    if (!["7d", "30d", "90d", "all"].includes(range)) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid range. Use: 7d, 30d, 90d, all." },
      });
    }

    const wherePlan = { userId, ...(planId ? { id: planId } : {}) };
    const plans = await prisma.plan.findMany({
      where: wherePlan,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        status: true,
        currency: true,
        memberCount: true,
        contributionAmount: true,
        currentCycleIndex: true,
        assignedPosition: true,
        createdAt: true,
      },
    });

    if (planId && plans.length === 0) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    }

    const planIds = plans.map((p) => p.id);
    if (planIds.length === 0) {
      return res.json({
        range,
        generatedAt: new Date().toISOString(),
        totals: {
          plans: 0,
          contributionsPaid: 0,
          contributionsPending: 0,
          contributionsLate: 0,
          contributionsMissed: 0,
          contributedAmount: 0,
          payoutsSent: 0,
          payoutsPending: 0,
          payoutsAmountSent: 0,
          approvedSwaps: 0,
          swapFeesCharged: 0,
        },
        plans: [],
      });
    }

    const start = resolveRangeStart(range);
    const dateFilter = start ? { gte: start } : undefined;

    const [contributions, payouts, swaps] = await Promise.all([
      prisma.contribution.findMany({
        where: {
          planId: { in: planIds },
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        select: {
          id: true,
          planId: true,
          status: true,
          amount: true,
        },
      }),
      prisma.payout.findMany({
        where: {
          planId: { in: planIds },
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        select: {
          id: true,
          planId: true,
          status: true,
          amount: true,
        },
      }),
      prisma.swap.findMany({
        where: {
          planId: { in: planIds },
          status: "APPROVED",
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        select: {
          id: true,
          planId: true,
          feeCharged: true,
        },
      }),
    ]);

    const byPlan = new Map();
    for (const p of plans) {
      byPlan.set(p.id, {
        planId: p.id,
        planName: p.name,
        status: p.status,
        currency: p.currency,
        assignedPosition: p.assignedPosition,
        currentCycle: Math.min(p.currentCycleIndex + 1, p.memberCount),
        memberCount: p.memberCount,
        monthlyContribution: p.contributionAmount,
        contributionsPaid: 0,
        contributionsPending: 0,
        contributionsLate: 0,
        contributionsMissed: 0,
        contributedAmount: 0,
        payoutsSent: 0,
        payoutsPending: 0,
        payoutsAmountSent: 0,
        approvedSwaps: 0,
        swapFeesCharged: 0,
      });
    }

    for (const c of contributions) {
      const row = byPlan.get(c.planId);
      if (!row) continue;
      if (c.status === "PAID") row.contributionsPaid += 1;
      if (c.status === "PENDING") row.contributionsPending += 1;
      if (c.status === "LATE") row.contributionsLate += 1;
      if (c.status === "MISSED") row.contributionsMissed += 1;
      if (c.status === "PAID" || c.status === "LATE") row.contributedAmount += Number(c.amount || 0);
    }

    for (const p of payouts) {
      const row = byPlan.get(p.planId);
      if (!row) continue;
      if (p.status === "SENT") {
        row.payoutsSent += 1;
        row.payoutsAmountSent += Number(p.amount || 0);
      }
      if (p.status === "PENDING") row.payoutsPending += 1;
    }

    for (const s of swaps) {
      const row = byPlan.get(s.planId);
      if (!row) continue;
      row.approvedSwaps += 1;
      row.swapFeesCharged += Number(s.feeCharged || 0);
    }

    const planRows = Array.from(byPlan.values()).map((row) => ({
      ...row,
      contributedAmount: Number(row.contributedAmount.toFixed(2)),
      payoutsAmountSent: Number(row.payoutsAmountSent.toFixed(2)),
      swapFeesCharged: Number(row.swapFeesCharged.toFixed(2)),
    }));

    const totals = planRows.reduce(
      (acc, r) => {
        acc.contributionsPaid += r.contributionsPaid;
        acc.contributionsPending += r.contributionsPending;
        acc.contributionsLate += r.contributionsLate;
        acc.contributionsMissed += r.contributionsMissed;
        acc.contributedAmount += r.contributedAmount;
        acc.payoutsSent += r.payoutsSent;
        acc.payoutsPending += r.payoutsPending;
        acc.payoutsAmountSent += r.payoutsAmountSent;
        acc.approvedSwaps += r.approvedSwaps;
        acc.swapFeesCharged += r.swapFeesCharged;
        return acc;
      },
      {
        plans: planRows.length,
        contributionsPaid: 0,
        contributionsPending: 0,
        contributionsLate: 0,
        contributionsMissed: 0,
        contributedAmount: 0,
        payoutsSent: 0,
        payoutsPending: 0,
        payoutsAmountSent: 0,
        approvedSwaps: 0,
        swapFeesCharged: 0,
      }
    );

    return res.json({
      range,
      generatedAt: new Date().toISOString(),
      totals: {
        ...totals,
        contributedAmount: Number(totals.contributedAmount.toFixed(2)),
        payoutsAmountSent: Number(totals.payoutsAmountSent.toFixed(2)),
        swapFeesCharged: Number(totals.swapFeesCharged.toFixed(2)),
      },
      plans: planRows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.getAdminContributionSplitReport = async (req, res) => {
  try {
    const range = String(req.query.range || "30d").toLowerCase();
    if (!["7d", "30d", "90d", "all"].includes(range)) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid range. Use: 7d, 30d, 90d, all." },
      });
    }

    const start = resolveRangeStart(range);
    const dateFilter = start ? { gte: start } : undefined;

    const [contributions, swaps] = await Promise.all([
      prisma.contribution.findMany({
        where: {
          status: { in: ["PAID", "LATE"] },
          ...(dateFilter ? { createdAt: dateFilter } : {}),
        },
        select: {
          amount: true,
          plan: {
            select: {
              contributionAmount: true,
            },
          },
        },
      }),
      prisma.swap.findMany({
        where: {
          status: "APPROVED",
          ...(dateFilter ? { reviewedAt: dateFilter } : {}),
        },
        select: { feeCharged: true },
      }),
    ]);

    let baseContributionTotal = 0;
    let positionInterestNet = 0;
    let positionInterestCharges = 0;
    let positionInterestCompensation = 0;
    let totalCollectedFromContributions = 0;

    for (const c of contributions) {
      const base = Number(c.plan?.contributionAmount || 0);
      const paid = Number(c.amount || 0);
      const delta = Number((paid - base).toFixed(2));
      baseContributionTotal += base;
      totalCollectedFromContributions += paid;
      positionInterestNet += delta;
      if (delta > 0) positionInterestCharges += delta;
      if (delta < 0) positionInterestCompensation += Math.abs(delta);
    }

    const swapFeesTotal = swaps.reduce((sum, s) => sum + Number(s.feeCharged || 0), 0);

    return res.json({
      range,
      generatedAt: new Date().toISOString(),
      totals: {
        contributionsCount: contributions.length,
        baseContributionTotal: Number(baseContributionTotal.toFixed(2)),
        totalCollectedFromContributions: Number(totalCollectedFromContributions.toFixed(2)),
        positionInterestNet: Number(positionInterestNet.toFixed(2)),
        positionInterestCharges: Number(positionInterestCharges.toFixed(2)),
        positionInterestCompensation: Number(positionInterestCompensation.toFixed(2)),
        approvedSwapFees: Number(swapFeesTotal.toFixed(2)),
        totalCharges: Number((positionInterestCharges + swapFeesTotal).toFixed(2)),
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
