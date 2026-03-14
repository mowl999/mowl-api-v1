const { prisma } = require("../db");
const { getUserTrustProfile, trustLevel, normalizeTrustThreshold } = require("../services/trust-score.service");
const { getPositionInterestRate, applyPositionInterest } = require("../services/position-interest.service");

// ---- helpers ----
async function getLatestRuleConfig() {
  return prisma.ruleConfig.findFirst({ orderBy: { version: "desc" } });
}

function randInt(min, max) {
  // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function assignPosition(memberCount, trustScore) {
  const level = trustLevel(trustScore);

  const first30End = Math.max(1, Math.floor(memberCount * 0.3));
  const last30Start = Math.min(memberCount, Math.ceil(memberCount * 0.7) + 1);

  if (level === "HIGH") {
    return randInt(1, first30End);
  }
  if (level === "LOW") {
    return randInt(last30Start, memberCount);
  }
  // MEDIUM → middle band
  return randInt(first30End + 1, last30Start - 1);
}

function validateCreatePlanBody(body) {
  const name = String(body.goalName || body.name || "").trim();
  const durationMonths = Number(body.durationMonths ?? body.memberCount);
  const monthlyContribution = Number(body.monthlyContribution ?? body.contributionAmount);
  const targetRaw = body.targetAmount;
  const frequency = body.frequency;

  if (!name || name.length < 3) return "goalName must be at least 3 characters.";
  if (!Number.isInteger(durationMonths) || durationMonths < 2 || durationMonths > 200) {
    return "durationMonths must be an integer between 2 and 200.";
  }
  if (!Number.isFinite(monthlyContribution) || monthlyContribution <= 0) {
    return "monthlyContribution must be > 0.";
  }
  if (frequency && frequency !== "MONTHLY") return "frequency must be MONTHLY.";

  if (targetRaw !== undefined && targetRaw !== null && targetRaw !== "") {
    const targetAmount = Number(targetRaw);
    if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
      return "targetAmount must be > 0.";
    }
    const expected = Number((durationMonths * monthlyContribution).toFixed(2));
    const diff = Math.abs(targetAmount - expected);
    if (diff > 0.01) {
      return "targetAmount must equal monthlyContribution * durationMonths.";
    }
  }

  return null;
}

function normalizeCreatePlanInput(body) {
  const goalName = String(body.goalName || body.name || "").trim();
  const durationMonths = Number(body.durationMonths ?? body.memberCount);
  const monthlyContribution = Number(body.monthlyContribution ?? body.contributionAmount);
  const targetAmount =
    body.targetAmount !== undefined && body.targetAmount !== null && body.targetAmount !== ""
      ? Number(body.targetAmount)
      : Number((durationMonths * monthlyContribution).toFixed(2));

  return {
    goalName,
    durationMonths,
    monthlyContribution,
    targetAmount,
    positionPreference: body.positionPreference,
    frequency: "MONTHLY",
  };
}

// ---- controller ----
exports.createPlan = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid token." } });
    }

    const errMsg = validateCreatePlanBody(req.body);
    if (errMsg) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: errMsg } });
    }

    const normalized = normalizeCreatePlanInput(req.body);
    const {
      goalName,
      durationMonths,
      monthlyContribution,
      targetAmount,
      frequency,
      positionPreference,
    } = normalized;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        state: true,
        createdAt: true,
        email: true,
        fullName: true,
        monthlyIncome: true,
        monthlyExpenses: true,
        otherMonthlyEarnings: true,
      },
    });

    if (!user) return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });

    // Must have done initial deposit (ACTIVE or ELIGIBLE)
    if (user.state === "INACTIVE") {
      return res.status(403).json({
        error: { code: "INITIAL_DEPOSIT_REQUIRED", message: "Initial deposit is required before creating a plan." },
      });
    }

    const rule = await getLatestRuleConfig();
    if (!rule) {
      return res.status(500).json({ error: { code: "RULE_CONFIG_MISSING", message: "Rule config not found." } });
    }

    const trust = await getUserTrustProfile(prisma, userId, {
      baseLimitPct: Number(rule.maxDisposableCommitmentPct || 0.6),
    });

    const trustScore = trust.trustScore;
    const trustFactor = trust.trustFactor;
    const baseLimitPct = trust.affordability.baseLimitPct;
    const adjustedLimitPct = trust.affordability.adjustedLimitPct;
    const monthlyDisposable = trust.affordability.monthlyDisposable;
    if (monthlyDisposable == null) {
      return res.status(403).json({
        error: {
          code: "INCOME_PROFILE_REQUIRED",
          message:
            "Income profile is required before creating a goal plan. Please provide monthly income and expenses.",
        },
      });
    }
    if (monthlyDisposable <= 0) {
      return res.status(403).json({
        error: {
          code: "INSUFFICIENT_DISPOSABLE_INCOME",
          message: "Your disposable monthly income is not sufficient to create a goal plan.",
        },
      });
    }

    const assignedPosition = assignPosition(Number(durationMonths), trustScore);
    const positionInterestRate = getPositionInterestRate(assignedPosition, Number(durationMonths), {
      earlyChargePct: rule.positionEarlyChargePct,
      lateCompensationPct: rule.positionLateCompensationPct,
    });
    const effectiveMonthlyContribution = applyPositionInterest(Number(monthlyContribution), positionInterestRate);

    const existingMonthlyCommitment = trust.affordability.currentMonthlyCommitment;
    const proposedMonthlyCommitment = Number(effectiveMonthlyContribution);
    const maxMonthlyExposure = Number(trust.affordability.maxMonthlyExposure || 0);
    const totalMonthlyCommitment = Number((existingMonthlyCommitment + proposedMonthlyCommitment).toFixed(2));

    if (totalMonthlyCommitment > maxMonthlyExposure) {
      return res.status(403).json({
        error: {
          code: "AFFORDABILITY_LIMIT_EXCEEDED",
          message:
            "This goal would push your monthly commitments above your allowed affordability limit.",
          details: {
            existingMonthlyCommitment,
            proposedMonthlyCommitment,
            totalMonthlyCommitment,
            maxMonthlyExposure,
            baseLimitPct,
            trustFactor,
            adjustedLimitPct,
            trustScore: Number(trustScore.toFixed(2)),
            monthlyDisposable,
            yearlyIncomeEstimate:
              (Number(user.monthlyIncome || 0) + Number(user.otherMonthlyEarnings || 0)) * 12,
            yearlyDisposableEstimate: monthlyDisposable * 12,
            assignedPosition,
            positionInterestRate,
            effectiveMonthlyContribution,
          },
        },
      });
    }

    // Eligibility checks (enforced here)
    const unmet = [];
    const minTrustScore = normalizeTrustThreshold(rule.eligibilityMinTrustScore);
    if (trust.creditScore < rule.eligibilityMinCredits) unmet.push("MIN_CREDIT_NOT_MET");
    if (trust.counts.contributionMonths < rule.eligibilityMinContributionMonths) unmet.push("MIN_MONTHS_NOT_MET");
    if (trustScore < minTrustScore) unmet.push("TRUST_SCORE_TOO_LOW");
    if (trust.counts.missedContributions > 0) unmet.push("UNRESOLVED_DEFAULTS");

    if (unmet.length > 0) {
      return res.status(403).json({
        error: {
          code: "NOT_ELIGIBLE",
          message: "You are not eligible to create a plan.",
          details: {
            unmet,
            metrics: {
              creditScore: trust.creditScore,
              trustScore,
              contributionMonths: trust.counts.contributionMonths,
              accountAgeMonths: trust.accountAgeMonths,
              penaltiesTotal: trust.penaltiesTotal,
              unresolvedDefaults: trust.counts.missedContributions > 0,
            },
            required: {
              minCredits: rule.eligibilityMinCredits,
              minContributionMonths: rule.eligibilityMinContributionMonths,
              minTrustScore,
            },
          },
        },
      });
    }

    const assignedPayoutMonth = assignedPosition;

    // Create plan + members in one transaction
    const result = await prisma.$transaction(async (tx) => {
      const plan = await tx.plan.create({
        data: {
          userId,
          name: goalName,
          memberCount: Number(durationMonths),
          contributionAmount: Number(monthlyContribution),
          currency: rule.currency || "GBP",
          frequency,
          status: "ACTIVE",
          ruleConfigId: rule.id,
          assignedPosition,
          swapsUsed: 0,
          currentCycleIndex: 0,
          feePoolAmount: 0,
        },
      });

      // Build members positions 1..N
      const membersData = [];
      for (let pos = 1; pos <= Number(durationMonths); pos += 1) {
        if (pos === assignedPosition) {
          membersData.push({
            planId: plan.id,
            type: "REAL",
            displayName: user.fullName || "You",
            position: pos,
          });
        } else {
          membersData.push({
            planId: plan.id,
            type: "VIRTUAL",
            displayName: `System Member ${pos}`,
            position: pos,
          });
        }
      }

      await tx.planMember.createMany({ data: membersData });

      // Log decision for explainability
      await tx.decisionLog.create({
        data: {
          decisionType: "POSITION_ASSIGNMENT",
          userId,
          planId: plan.id,
          inputs: {
            creditScore: trust.creditScore,
            trustScore,
            preference: positionPreference || null,
            durationMonths: Number(durationMonths),
            monthlyContribution: Number(monthlyContribution),
            targetAmount: Number(targetAmount),
          },
          ruleApplied: `BAND_${trustLevel(trustScore)}_AUTO_ASSIGN`,
          outcome: { assignedPosition },
        },
      });

      // (Optional) set to ELIGIBLE after successful plan creation
      if (user.state !== "ELIGIBLE") {
        await tx.user.update({ where: { id: userId }, data: { state: "ELIGIBLE" } });
      }

      return plan;
    });

    return res.status(201).json({
      id: result.id,
      name: result.name,
      goalName: result.name,
      memberCount: result.memberCount,
      durationMonths: result.memberCount,
      contributionAmount: result.contributionAmount,
      monthlyContribution: result.contributionAmount,
      targetAmount: Number((result.memberCount * result.contributionAmount).toFixed(2)),
      currency: result.currency,
      frequency: result.frequency,
      status: result.status,
      ruleConfigId: result.ruleConfigId,
      assignedPosition: result.assignedPosition,
      assignedPayoutMonth,
      assignmentExplanation: {
        trustLevel: trustLevel(trustScore),
        reasonCode:
          trustLevel(trustScore) === "HIGH"
            ? "TRUST_HIGH_EARLY_BAND"
            : trustLevel(trustScore) === "MEDIUM"
            ? "TRUST_MEDIUM_MIDDLE_BAND"
            : "TRUST_LOW_LATE_BAND",
        inputs: { creditScore: trust.creditScore, trustScore: Number(trustScore.toFixed(2)), positionPreference: positionPreference || null },
      },
      positionInterestRate,
      effectiveMonthlyContribution,
      swapsUsed: result.swapsUsed,
      currentCycleIndex: result.currentCycleIndex,
      affordability: {
        existingMonthlyCommitment,
        proposedMonthlyCommitment,
        totalMonthlyCommitment,
        maxMonthlyExposure,
        baseLimitPct,
        trustFactor,
        adjustedLimitPct,
        trustScore: Number(trustScore.toFixed(2)),
      },
      createdAt: result.createdAt,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.getPlanMembers = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    // Ensure plan exists and belongs to user (owner-only for MVP)
    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: { id: true, userId: true, memberCount: true, assignedPosition: true },
    });

    if (!plan) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    }

    if (plan.userId !== userId) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have access to this plan." } });
    }

    const members = await prisma.planMember.findMany({
      where: { planId },
      orderBy: { position: "asc" },
      select: { id: true, type: true, displayName: true, position: true },
    });

    return res.json({
      planId: plan.id,
      memberCount: plan.memberCount,
      assignedPosition: plan.assignedPosition,
      items: members,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listPlans = async (req, res) => {
  try {
    const userId = req.user?.id;

    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const cursor = req.query.cursor || null;

    const where = { userId };

    const plans = await prisma.plan.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        name: true,
        status: true,
        memberCount: true,
        contributionAmount: true,
        currency: true,
        frequency: true,
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

    const hasNext = plans.length > limit;
    const rawItems = hasNext ? plans.slice(0, limit) : plans;
    const nextCursor = hasNext ? rawItems[rawItems.length - 1].id : null;
    const items = rawItems.map((p) => {
      const { ruleConfig, ...plan } = p;
      const rate = getPositionInterestRate(plan.assignedPosition, plan.memberCount, {
        earlyChargePct: ruleConfig?.positionEarlyChargePct,
        lateCompensationPct: ruleConfig?.positionLateCompensationPct,
      });
      return {
        ...plan,
        positionInterestRate: rate,
        effectiveMonthlyContribution: applyPositionInterest(plan.contributionAmount, rate),
        goalName: plan.name,
        durationMonths: plan.memberCount,
        monthlyContribution: plan.contributionAmount,
        targetAmount: Number((plan.memberCount * plan.contributionAmount).toFixed(2)),
        assignedPayoutMonth: plan.assignedPosition,
      };
    });

    return res.json({ items, nextCursor });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Something went wrong." },
    });
  }
};
