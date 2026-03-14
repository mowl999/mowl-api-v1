const { prisma } = require("../db");
const { getUserTrustProfile, trustLevel, clamp } = require("../services/trust-score.service");
const {
  getPositionInterestRate,
  applyPositionInterest,
  applyPayoutPositionInterest,
} = require("../services/position-interest.service");

function monthKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function buildDailyTrendFromDates(dates, days, endDate = new Date()) {
  const endDay = startOfDay(endDate);
  const startDay = addDays(endDay, -(days - 1));
  const counts = new Map();

  for (const dt of dates) {
    const d = startOfDay(dt);
    if (d < startDay || d > endDay) continue;
    const key = dayKey(d);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = addDays(startDay, i);
    const key = dayKey(d);
    out.push({
      date: key,
      value: counts.get(key) || 0,
    });
  }
  return out;
}

function trustReasonSummary(row) {
  const reasons = [];
  if (row.paidCount > 0) reasons.push(`${row.paidCount} on-time payment(s) improved trust.`);
  if (row.lateCount > 0) reasons.push(`${row.lateCount} late payment(s) reduced trust momentum.`);
  if (row.missedCount > 0) reasons.push(`${row.missedCount} missed payment(s) lowered trust.`);
  if (row.penaltyCount > 0) reasons.push(`${row.penaltyCount} penalty event(s) impacted trust.`);
  if (reasons.length === 0) reasons.push("No major payment activity this month.");
  return reasons;
}

// GET /v1/dashboard/user
exports.getUserDashboard = async (req, res) => {
  try {
    const userId = req.user?.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, createdAt: true, state: true, role: true },
    });

    const trust = await getUserTrustProfile(prisma, userId);

    const plans = await prisma.plan.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        name: true,
        status: true,
        memberCount: true,
        contributionAmount: true,
        currency: true,
        assignedPosition: true,
        swapsUsed: true,
        currentCycleIndex: true,
        createdAt: true,
        ruleConfig: {
          select: {
            positionEarlyChargePct: true,
            positionLateCompensationPct: true,
          },
        },
      },
    });

    // For each plan, show next payout recipient and your payout cycle
    const planIds = plans.map(p => p.id);
    const members = await prisma.planMember.findMany({
      where: { planId: { in: planIds } },
      select: { planId: true, type: true, position: true, displayName: true },
    });

    const membersByPlan = new Map();
    for (const m of members) {
      if (!membersByPlan.has(m.planId)) membersByPlan.set(m.planId, []);
      membersByPlan.get(m.planId).push(m);
    }

    const items = plans.map((p) => {
      const list = membersByPlan.get(p.id) || [];
      const you = list.find(m => m.type === "REAL");
      const yourPayoutCycleIndex = (you?.position ?? 1) - 1;
      const nextRecipientPosition = p.currentCycleIndex + 1;
      const nextRecipient = list.find(m => m.position === nextRecipientPosition) || null;

      const rate = getPositionInterestRate(p.assignedPosition, p.memberCount, {
        earlyChargePct: p.ruleConfig?.positionEarlyChargePct,
        lateCompensationPct: p.ruleConfig?.positionLateCompensationPct,
      });
      const { ruleConfig, ...plan } = p;

      return {
        ...plan,
        positionInterestRate: rate,
        effectiveMonthlyContribution: applyPositionInterest(p.contributionAmount, rate),
        you: { position: you?.position ?? null, payoutCycleIndex: yourPayoutCycleIndex },
        nextPayout: plan.currentCycleIndex >= plan.memberCount
          ? null
          : {
              cycleIndex: plan.currentCycleIndex,
              recipientPosition: nextRecipientPosition,
              recipientName: nextRecipient?.displayName ?? null,
              recipientType: nextRecipient?.type ?? null,
              potAmount: applyPayoutPositionInterest(
                plan.memberCount * plan.contributionAmount,
                getPositionInterestRate(nextRecipientPosition, plan.memberCount, {
                  earlyChargePct: ruleConfig?.positionEarlyChargePct,
                  lateCompensationPct: ruleConfig?.positionLateCompensationPct,
                })
              ),
            },
      };
    });

    return res.json({
      user: { id: user.id, email: user.email, fullName: user.fullName, state: user.state, role: user.role },
      reputation: {
        creditScore: trust.creditScore,
        trustScore: trust.trustScore,
        trustLevel: trust.trustLevel,
        penaltiesTotal: trust.penaltiesTotal,
        accountAgeMonths: trust.accountAgeMonths,
      },
      plans: items,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

// GET /v1/dashboard/trust-history
exports.getTrustHistory = async (req, res) => {
  try {
    const userId = req.user?.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true },
    });
    if (!user) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    }

    const months = Math.max(3, Math.min(24, Number(req.query.months) || 6));
    const now = new Date();
    const endMonth = startOfMonth(now);
    const requestedStartMonth = addMonths(endMonth, -(months - 1));
    const accountStartMonth = startOfMonth(user.createdAt);
    const startMonth = requestedStartMonth > accountStartMonth ? requestedStartMonth : accountStartMonth;

    const monthKeys = [];
    for (let cursor = new Date(startMonth); cursor <= endMonth; cursor = addMonths(cursor, 1)) {
      monthKeys.push(monthKey(cursor));
    }
    const byMonth = new Map(
      monthKeys.map((k) => [
        k,
        {
          month: k,
          paidCount: 0,
          lateCount: 0,
          missedCount: 0,
          creditsEarned: 0,
          penaltyCount: 0,
          penaltiesTotal: 0,
          creditScoreEnd: 0,
          trustScore: 0,
          trustLevel: "LOW",
          changeFromPrevious: 0,
          reasons: [],
        },
      ])
    );

    const [contributions, penalties, ledgers, baselineLedger, baselinePenaltyAgg] = await Promise.all([
      prisma.contribution.findMany({
        where: { userId, createdAt: { gte: startMonth } },
        select: { status: true, creditsAwarded: true, createdAt: true, paidAt: true },
      }),
      prisma.penalty.findMany({
        where: { userId, createdAt: { gte: startMonth } },
        select: { createdAt: true, creditsDelta: true, code: true },
      }),
      prisma.creditLedger.findMany({
        where: { userId, createdAt: { gte: startMonth } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, balanceAfter: true },
      }),
      prisma.creditLedger.findFirst({
        where: { userId, createdAt: { lt: startMonth } },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true },
      }),
      prisma.penalty.aggregate({
        where: { userId, createdAt: { lt: startMonth } },
        _sum: { creditsDelta: true },
      }),
    ]);

    for (const c of contributions) {
      const evtDate = c.paidAt || c.createdAt;
      const key = monthKey(evtDate);
      const row = byMonth.get(key);
      if (!row) continue;
      if (c.status === "PAID") row.paidCount += 1;
      if (c.status === "LATE") row.lateCount += 1;
      if (c.status === "MISSED") row.missedCount += 1;
      row.creditsEarned += Number(c.creditsAwarded || 0);
    }

    for (const p of penalties) {
      const key = monthKey(p.createdAt);
      const row = byMonth.get(key);
      if (!row) continue;
      row.penaltyCount += 1;
      row.penaltiesTotal += Math.abs(Number(p.creditsDelta || 0));
    }

    // Credit score end-of-month (carry forward last known balance)
    let runningCredit = Number(baselineLedger?.balanceAfter || 0);
    let ledgerIdx = 0;
    for (const key of monthKeys) {
      const monthDate = new Date(`${key}-01T00:00:00.000Z`);
      const nextMonthDate = addMonths(monthDate, 1);
      while (ledgerIdx < ledgers.length && ledgers[ledgerIdx].createdAt < nextMonthDate) {
        runningCredit = Number(ledgers[ledgerIdx].balanceAfter || runningCredit);
        ledgerIdx += 1;
      }
      const row = byMonth.get(key);
      row.creditScoreEnd = Number(runningCredit.toFixed(2));
    }

    let cumulativePenalties = Math.abs(Number(baselinePenaltyAgg._sum.creditsDelta || 0));
    let prevTrust = null;

    const items = monthKeys.map((key) => {
      const row = byMonth.get(key);
      cumulativePenalties += Number(row.penaltiesTotal || 0);

      const mDate = new Date(`${key}-01T00:00:00.000Z`);
      const ageMonths = Math.max(
        0,
        (mDate.getFullYear() - user.createdAt.getFullYear()) * 12 +
          (mDate.getMonth() - user.createdAt.getMonth())
      );
      const rawTrustScore = (row.creditScoreEnd / Math.max(1, ageMonths / 3)) - cumulativePenalties;
      const trustScore = clamp(Number(((rawTrustScore + 20) * 9).toFixed(2)), 0, 900);
      row.trustScore = trustScore;
      row.trustLevel = trustLevel(trustScore);
      row.changeFromPrevious = prevTrust == null ? 0 : Number((row.trustScore - prevTrust).toFixed(2));
      row.reasons = trustReasonSummary(row);
      prevTrust = row.trustScore;
      return row;
    });

    return res.json({ months, items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

// GET /v1/dashboard/admin
exports.getAdminDashboard = async (req, res) => {
  try {
    const now = new Date();
    const trendStart30 = addDays(startOfDay(now), -29);
    const hasUserWorkspace = !!prisma.userWorkspace;
    const hasInvestmentPlan = !!prisma.investmentPlan;
    const hasLoanTransaction = !!prisma.loanTransaction;
    const hasFundTransferTransaction = !!prisma.fundTransferTransaction;

    // system totals
    const [
      totalUsers,
      activePlans,
      totalPlans,
      missedContribs,
      pendingPayouts,
      pausesSubmittedCount,
      pausesApprovedCount,
      pausesRejectedCount,
      pausesSubmittedFeesAgg,
      pausesApprovedFeesAgg,
      workspaceCounts,
      totalInvestPlans,
      activeInvestPlans,
      investUsersWithPlans,
      loanTxCount,
      loanUsersWithActivity,
      fundTransferTxCount,
      fundTransferUsersWithActivity,
      workspaceAssignments30d,
      contributionActivity30d,
      investActivity30d,
      loanActivity30d,
      fundTransferActivity30d,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.plan.count({ where: { status: "ACTIVE" } }),
      prisma.plan.count(),
      prisma.contribution.count({ where: { status: "MISSED" } }),
      prisma.payout.count({ where: { status: "PENDING" } }).catch(() => 0), // in case Payout not added yet
      prisma.planPause.count({ where: { status: "SUBMITTED" } }).catch(() => 0),
      prisma.planPause.count({ where: { status: "APPROVED" } }).catch(() => 0),
      prisma.planPause.count({ where: { status: "REJECTED" } }).catch(() => 0),
      prisma.planPause.aggregate({ where: { status: "SUBMITTED" }, _sum: { totalFee: true } }).catch(() => ({ _sum: { totalFee: 0 } })),
      prisma.planPause.aggregate({ where: { status: "APPROVED" }, _sum: { totalFee: true } }).catch(() => ({ _sum: { totalFee: 0 } })),
      hasUserWorkspace
        ? prisma.userWorkspace
            .groupBy({
              by: ["workspace"],
              _count: { _all: true },
            })
            .catch(() => [])
        : Promise.resolve([]),
      hasInvestmentPlan ? prisma.investmentPlan.count().catch(() => 0) : Promise.resolve(0),
      hasInvestmentPlan
        ? prisma.investmentPlan.count({ where: { status: "ACTIVE" } }).catch(() => 0)
        : Promise.resolve(0),
      hasInvestmentPlan
        ? prisma.investmentPlan.groupBy({ by: ["userId"] }).then((rows) => rows.length).catch(() => 0)
        : Promise.resolve(0),
      hasLoanTransaction ? prisma.loanTransaction.count().catch(() => 0) : Promise.resolve(0),
      hasLoanTransaction
        ? prisma.loanTransaction.groupBy({ by: ["userId"] }).then((rows) => rows.length).catch(() => 0)
        : Promise.resolve(0),
      hasFundTransferTransaction ? prisma.fundTransferTransaction.count().catch(() => 0) : Promise.resolve(0),
      hasFundTransferTransaction
        ? prisma.fundTransferTransaction.groupBy({ by: ["userId"] }).then((rows) => rows.length).catch(() => 0)
        : Promise.resolve(0),
      hasUserWorkspace
        ? prisma.userWorkspace
            .findMany({
              where: {
                workspace: { in: ["THRIFT", "INVEST", "LOANS", "FUND_TRANSFERS"] },
                createdAt: { gte: trendStart30 },
              },
              select: { workspace: true, createdAt: true },
            })
            .catch(() => [])
        : Promise.resolve([]),
      prisma.contribution.findMany({
        where: { createdAt: { gte: trendStart30 } },
        select: { createdAt: true },
      }).catch(() => []),
      hasInvestmentPlan
        ? prisma.investmentPlan
            .findMany({
              where: { createdAt: { gte: trendStart30 } },
              select: { createdAt: true },
            })
            .catch(() => [])
        : Promise.resolve([]),
      hasLoanTransaction
        ? prisma.loanTransaction
            .findMany({
              where: { createdAt: { gte: trendStart30 } },
              select: { createdAt: true },
            })
            .catch(() => [])
        : Promise.resolve([]),
      hasFundTransferTransaction
        ? prisma.fundTransferTransaction
            .findMany({
              where: { createdAt: { gte: trendStart30 } },
              select: { createdAt: true },
            })
            .catch(() => [])
        : Promise.resolve([]),
    ]);

    // risk list: users with many missed contributions
    const risky = await prisma.contribution.groupBy({
      by: ["userId"],
      where: { status: "MISSED" },
      _count: { _all: true },
      orderBy: { _count: { userId: "desc" } },
      take: 10,
    });

    const riskyUserIds = risky.map(r => r.userId);
    const riskyUsers = riskyUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: riskyUserIds } },
          select: { id: true, email: true, fullName: true, state: true },
        })
      : [];

    const riskItems = risky.map(r => {
      const u = riskyUsers.find(x => x.id === r.userId);
      return {
        userId: r.userId,
        missedCount: r._count?.userId ?? 0,
        email: u?.email,
        fullName: u?.fullName,
        state: u?.state,
      };
    });

    const usersByWorkspace = workspaceCounts.reduce((acc, item) => {
      acc[item.workspace] = item?._count?._all ?? 0;
      return acc;
    }, {});

    const workspaceDates = (workspaceKey) =>
      workspaceAssignments30d
        .filter((x) => x.workspace === workspaceKey)
        .map((x) => x.createdAt);

    const buildTrends = (userDates, activityDates) => ({
      users: {
        d7: buildDailyTrendFromDates(userDates, 7, now),
        d30: buildDailyTrendFromDates(userDates, 30, now),
      },
      activity: {
        d7: buildDailyTrendFromDates(activityDates, 7, now),
        d30: buildDailyTrendFromDates(activityDates, 30, now),
      },
    });

    return res.json({
      totals: {
        users: totalUsers,
        plans: totalPlans,
        activePlans,
        missedContributions: missedContribs,
        pendingPayouts,
      },
      risk: {
        topMissedUsers: riskItems,
      },
      queues: {
        pendingPayouts,
      },
      products: {
        thrift: {
          users: usersByWorkspace.THRIFT || 0,
          plans: totalPlans,
          activePlans,
          missedContributions: missedContribs,
          pendingPayouts,
          pauseRequestsSubmitted: pausesSubmittedCount,
          trends: buildTrends(
            workspaceDates("THRIFT"),
            contributionActivity30d.map((x) => x.createdAt)
          ),
        },
        investment: {
          users: usersByWorkspace.INVEST || 0,
          plans: totalInvestPlans,
          activePlans: activeInvestPlans,
          accountsWithActivity: investUsersWithPlans,
          trends: buildTrends(
            workspaceDates("INVEST"),
            investActivity30d.map((x) => x.createdAt)
          ),
        },
        loans: {
          users: usersByWorkspace.LOANS || 0,
          accountsWithActivity: loanUsersWithActivity,
          transactions: loanTxCount,
          trends: buildTrends(
            workspaceDates("LOANS"),
            loanActivity30d.map((x) => x.createdAt)
          ),
        },
        fundTransfers: {
          users: usersByWorkspace.FUND_TRANSFERS || 0,
          accountsWithActivity: fundTransferUsersWithActivity,
          transactions: fundTransferTxCount,
          trends: buildTrends(
            workspaceDates("FUND_TRANSFERS"),
            fundTransferActivity30d.map((x) => x.createdAt)
          ),
        },
      },
      pauses: {
        submittedCount: pausesSubmittedCount,
        approvedCount: pausesApprovedCount,
        rejectedCount: pausesRejectedCount,
        submittedFeesTotal: Number((pausesSubmittedFeesAgg?._sum?.totalFee || 0).toFixed(2)),
        approvedFeesTotal: Number((pausesApprovedFeesAgg?._sum?.totalFee || 0).toFixed(2)),
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
