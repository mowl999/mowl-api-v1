function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function trustLevel(trustScore) {
  if (trustScore >= 700) return "HIGH";
  if (trustScore >= 450) return "MEDIUM";
  return "LOW";
}

function trustAffordabilityFactor(trustScore) {
  const normalized = clamp(Number(trustScore || 0), 0, 900) / 900;
  return Number((0.8 + normalized * 0.4).toFixed(4));
}

function normalizeTrustThreshold(raw) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 100) return Number((n * 9).toFixed(2));
  return n;
}

function monthsBetween(dateA, dateB) {
  const years = dateB.getFullYear() - dateA.getFullYear();
  const months = dateB.getMonth() - dateA.getMonth();
  return years * 12 + months + (dateB.getDate() >= dateA.getDate() ? 0 : -1);
}

async function getUserTrustProfile(prisma, userId, options = {}) {
  const baseLimitPct = Number(options.baseLimitPct || 0.6);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      createdAt: true,
      monthlyIncome: true,
      monthlyExpenses: true,
      otherMonthlyEarnings: true,
    },
  });
  if (!user) throw { status: 404, code: "NOT_FOUND", message: "User not found." };

  const [
    latestCredit,
    penalties,
    paidCount,
    lateCount,
    missedCount,
    paidLateRows,
    payoutsCollected,
    completedPlansByCycles,
    activePlans,
  ] = await Promise.all([
    prisma.creditLedger.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    }),
    prisma.penalty.findMany({
      where: { userId },
      select: { creditsDelta: true },
    }),
    prisma.contribution.count({ where: { userId, status: "PAID" } }),
    prisma.contribution.count({ where: { userId, status: "LATE" } }),
    prisma.contribution.count({ where: { userId, status: "MISSED" } }),
    prisma.contribution.findMany({
      where: { userId, status: { in: ["PAID", "LATE"] } },
      select: { createdAt: true },
    }),
    prisma.payout.count({
      where: { status: "SENT", recipientType: "REAL", plan: { userId } },
    }),
    prisma.plan.findMany({
      where: { userId },
      select: { id: true, status: true, currentCycleIndex: true, memberCount: true },
    }),
    prisma.plan.findMany({
      where: { userId, status: "ACTIVE" },
      select: { contributionAmount: true, currentCycleIndex: true, memberCount: true },
    }),
  ]);

  const creditScore = Number(latestCredit?.balanceAfter || 0);
  const penaltiesTotal = penalties.reduce((sum, p) => sum + Math.abs(Number(p.creditsDelta || 0)), 0);
  const accountAgeMonths = Math.max(0, monthsBetween(user.createdAt, new Date()));

  const contributionMonths = new Set(
    paidLateRows.map((c) => `${c.createdAt.getFullYear()}-${c.createdAt.getMonth() + 1}`)
  ).size;

  const monthlyIncome = Number(user.monthlyIncome);
  const monthlyExpenses = Number(user.monthlyExpenses);
  const otherMonthlyEarnings = Number(user.otherMonthlyEarnings || 0);
  const hasIncomeProfile = Number.isFinite(monthlyIncome) && Number.isFinite(monthlyExpenses);
  const monthlyDisposable = hasIncomeProfile ? monthlyIncome + otherMonthlyEarnings - monthlyExpenses : null;

  const currentMonthlyCommitment = activePlans
    .filter((p) => p.currentCycleIndex < p.memberCount)
    .reduce((sum, p) => sum + Number(p.contributionAmount || 0), 0);

  const maxMonthlyExposure =
    monthlyDisposable != null ? Number((monthlyDisposable * baseLimitPct).toFixed(2)) : null;
  const commitmentRatio =
    maxMonthlyExposure != null && maxMonthlyExposure > 0
      ? currentMonthlyCommitment / maxMonthlyExposure
      : null;

  const completedPlanIds = new Set();
  for (const p of completedPlansByCycles) {
    if (p.status === "COMPLETED" || p.currentCycleIndex >= p.memberCount) completedPlanIds.add(p.id);
  }
  const completedPlans = completedPlanIds.size;
  const hasTrustActivity =
    paidCount > 0 ||
    lateCount > 0 ||
    missedCount > 0 ||
    payoutsCollected > 0 ||
    completedPlans > 0 ||
    creditScore > 0 ||
    penaltiesTotal > 0;

  // 0..900 trust model
  const basePoints = hasTrustActivity ? 250 : 0;
  const contributionPoints = clamp(paidCount * 10 + lateCount * 4 - missedCount * 30, -250, 320);
  const payoutPoints = clamp(payoutsCollected * 35, 0, 175);
  const completedPlanPoints = clamp(completedPlans * 45, 0, 225);
  const creditPoints = clamp((clamp(creditScore, 0, 500) / 500) * 50, 0, 50);
  const penaltyPoints = clamp(-penaltiesTotal * 0.5, -140, 0);

  let profileAffordabilityPoints = 0;
  if (!hasIncomeProfile) {
    profileAffordabilityPoints = -60;
  } else if ((monthlyDisposable || 0) <= 0) {
    profileAffordabilityPoints = -120;
  } else if (commitmentRatio == null) {
    profileAffordabilityPoints = 10;
  } else if (commitmentRatio <= 0.6) {
    profileAffordabilityPoints = 80;
  } else if (commitmentRatio <= 0.85) {
    profileAffordabilityPoints = 40;
  } else if (commitmentRatio <= 1.0) {
    profileAffordabilityPoints = 10;
  } else if (commitmentRatio <= 1.2) {
    profileAffordabilityPoints = -40;
  } else {
    profileAffordabilityPoints = -80;
  }

  const computedTrustScore = clamp(
    Number(
      (
        basePoints +
        contributionPoints +
        payoutPoints +
        completedPlanPoints +
        creditPoints +
        penaltyPoints +
        profileAffordabilityPoints
      ).toFixed(2)
    ),
    0,
    900
  );
  const trustScore = hasTrustActivity ? computedTrustScore : 0;

  const factor = hasTrustActivity ? trustAffordabilityFactor(trustScore) : 1;
  const adjustedLimitPct = clamp(Number((baseLimitPct * factor).toFixed(4)), 0.3, 0.95);
  const adjustedMaxMonthlyExposure =
    monthlyDisposable != null ? Number((monthlyDisposable * adjustedLimitPct).toFixed(2)) : null;
  const remainingMonthlyCapacity =
    adjustedMaxMonthlyExposure != null
      ? Number((adjustedMaxMonthlyExposure - currentMonthlyCommitment).toFixed(2))
      : null;

  return {
    trustScore,
    trustLevel: trustLevel(trustScore),
    trustFactor: factor,
    creditScore,
    penaltiesTotal: Number(penaltiesTotal.toFixed(2)),
    accountAgeMonths,
    counts: {
      paidContributions: paidCount,
      lateContributions: lateCount,
      missedContributions: missedCount,
      payoutsCollected,
      completedPlans,
      contributionMonths,
    },
    affordability: {
      hasIncomeProfile,
      monthlyDisposable,
      currentMonthlyCommitment: Number(currentMonthlyCommitment.toFixed(2)),
      baseLimitPct,
      adjustedLimitPct,
      maxMonthlyExposure: adjustedMaxMonthlyExposure,
      remainingMonthlyCapacity,
      yearlyIncomeEstimate: hasIncomeProfile ? (monthlyIncome + otherMonthlyEarnings) * 12 : null,
      yearlyDisposableEstimate: monthlyDisposable != null ? monthlyDisposable * 12 : null,
      commitmentRatio: commitmentRatio != null ? Number(commitmentRatio.toFixed(4)) : null,
    },
    components: {
      basePoints,
      contributionPoints,
      payoutPoints,
      completedPlanPoints,
      creditPoints,
      penaltyPoints,
      profileAffordabilityPoints,
    },
    hasTrustActivity,
  };
}

module.exports = {
  clamp,
  trustLevel,
  trustAffordabilityFactor,
  normalizeTrustThreshold,
  monthsBetween,
  getUserTrustProfile,
};
