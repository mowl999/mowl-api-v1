const { prisma } = require("../db");
const { getUserTrustProfile, normalizeTrustThreshold } = require("../services/trust-score.service");
const { ensureDefaultRuleConfig } = require("../services/rules.service");


exports.getEligibility = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { state: true, createdAt: true },
    });

    if (!user) {
      return res.status(404).json({
        error: { code: "NOT_FOUND", message: "User not found." },
      });
    }

    const rule = await ensureDefaultRuleConfig();

    const trust = await getUserTrustProfile(prisma, userId, {
      baseLimitPct: Number(rule.maxDisposableCommitmentPct || 0.6),
    });
    const creditScore = trust.creditScore;
    const penaltiesTotal = trust.penaltiesTotal;
    const contributionMonths = trust.counts.contributionMonths;
    const unresolvedDefaults = trust.counts.missedContributions > 0;
    const trustScore = trust.trustScore;
    const minTrustScore = normalizeTrustThreshold(rule.eligibilityMinTrustScore);

    const unmetRequirements = [];

    // 1) Initial deposit gate / state gate
    if (user.state === "INACTIVE") {
      unmetRequirements.push({
        code: "INITIAL_DEPOSIT_REQUIRED",
        message: "Initial deposit is required before you can proceed.",
      });
    }

    // 2) Minimum credits
    if (creditScore < rule.eligibilityMinCredits) {
      unmetRequirements.push({
        code: "MIN_CREDIT_NOT_MET",
        message: "Minimum credit score not met.",
        currentValue: String(creditScore),
        requiredValue: String(rule.eligibilityMinCredits),
      });
    }

    // 3) Minimum contribution months
    if (contributionMonths < rule.eligibilityMinContributionMonths) {
      unmetRequirements.push({
        code: "MIN_MONTHS_NOT_MET",
        message: "Minimum contribution months not met.",
        currentValue: String(contributionMonths),
        requiredValue: String(rule.eligibilityMinContributionMonths),
      });
    }

    // 4) Trust score threshold
    if (trustScore < minTrustScore) {
      unmetRequirements.push({
        code: "TRUST_SCORE_TOO_LOW",
        message: "Trust score is below the minimum required.",
        currentValue: String(Number(trustScore)),
        requiredValue: String(minTrustScore),
      });
    }

    // 5) Defaults
    if (unresolvedDefaults) {
      unmetRequirements.push({
        code: "UNRESOLVED_DEFAULTS",
        message: "You have unresolved missed contributions/defaults.",
      });
    }

    // Eligible means: no unmet requirements and user is ACTIVE (or ELIGIBLE already)
    const eligible =
      unmetRequirements.length === 0 && (user.state === "ACTIVE" || user.state === "ELIGIBLE");

    // Optionally auto-set user state to ELIGIBLE when they qualify
 // Eligibility check should not change user state


    return res.json({
      eligible,
      userState:  user.state,
      unmetRequirements,
      metrics: {
        creditScore,
        trustScore: Number(trustScore),
        contributionMonths,
        accountAgeMonths: trust.accountAgeMonths,
        penaltiesTotal,
        unresolvedDefaults,
      },
      ruleSnapshot: {
        minCredits: rule.eligibilityMinCredits,
        minContributionMonths: rule.eligibilityMinContributionMonths,
        minTrustScore,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Something went wrong." },
    });
  }
};
