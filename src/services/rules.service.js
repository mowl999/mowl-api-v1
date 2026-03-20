const { prisma } = require("../db");

const DEFAULT_RULE_CONFIG = {
  version: 1,
  currency: "GBP",
  minInitialDeposit: 100,
  creditRatePer10: 1,
  multiplierEarly: 1.2,
  multiplierOnTime: 1,
  multiplierLate: 0.7,
  eligibilityMinCredits: 0,
  eligibilityMinContributionMonths: 0,
  eligibilityMinPercent: 0,
  eligibilityMinTrustScore: 0,
  postPayoutMissedPenaltyMultiplier: 2,
  maxDisposableCommitmentPct: 0.6,
  positionEarlyChargePct: 0.1,
  positionLateCompensationPct: 0.03,
  contributionsCountryCode: "GB",
  contributionsEnabledPaymentMethods: ["CARD", "PAY_BY_BANK", "DIRECT_DEBIT", "BANK_TRANSFER_MANUAL"],
  pauseFeatureEnabled: true,
  pauseFeePerMonth: 50,
  maxPauseMonths: 2,
  swapFactor: 1,
  swapDiscountRate: 0,
  maxSwapsPerPlan: 1,
  feeFloorAmount: 0,
  missedPaymentCredits: -20,
  swapAbuseCredits: -10,
  planDefaultCredits: 0,
};

async function getCurrentRuleConfig() {
  // latest by version
  const cfg = await prisma.ruleConfig.findFirst({
    orderBy: { version: "desc" },
  });

  return cfg; // may be null if not seeded
}

async function ensureDefaultRuleConfig() {
  const existing = await getCurrentRuleConfig();
  if (existing) return existing;

  try {
    return await prisma.ruleConfig.create({
      data: DEFAULT_RULE_CONFIG,
    });
  } catch (error) {
    if (error?.code === "P2002") {
      return getCurrentRuleConfig();
    }
    throw error;
  }
}

module.exports = { DEFAULT_RULE_CONFIG, getCurrentRuleConfig, ensureDefaultRuleConfig };
