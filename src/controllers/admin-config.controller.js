const { z } = require("zod");
const { prisma } = require("../db");

const updateRuleSchema = z
  .object({
    maxDisposableCommitmentPct: z.number().min(0.1).max(1).optional(),
    positionEarlyChargePct: z.number().min(0).max(0.5).optional(),
    positionLateCompensationPct: z.number().min(0).max(0.5).optional(),
    swapFactor: z.number().min(0).max(100).optional(),
    swapDiscountRate: z.number().min(0).max(1).optional(),
    feeFloorAmount: z.number().min(0).max(1000000).optional(),
    maxSwapsPerPlan: z.number().int().min(0).max(24).optional(),
    missedPaymentCredits: z.number().max(0).min(-10000).optional(),
    postPayoutMissedPenaltyMultiplier: z.number().min(1).max(10).optional(),
    contributionsCountryCode: z.string().length(2).optional(),
    contributionsEnabledPaymentMethods: z
      .array(z.enum(["CARD", "PAY_BY_BANK", "DIRECT_DEBIT", "BANK_TRANSFER_MANUAL"]))
      .min(1)
      .optional(),
    pauseFeatureEnabled: z.boolean().optional(),
    pauseFeePerMonth: z.number().min(0).max(1000000).optional(),
    maxPauseMonths: z.number().int().min(0).max(24).optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one config field must be provided.",
  });

async function getLatestRule() {
  return prisma.ruleConfig.findFirst({ orderBy: { version: "desc" } });
}

function toRuleResponse(rule) {
  const enabledPaymentMethods = Array.isArray(rule.contributionsEnabledPaymentMethods)
    ? rule.contributionsEnabledPaymentMethods
    : ["CARD", "PAY_BY_BANK", "DIRECT_DEBIT", "BANK_TRANSFER_MANUAL"];
  return {
    id: rule.id,
    version: rule.version,
    currency: rule.currency,
    maxDisposableCommitmentPct: Number(rule.maxDisposableCommitmentPct),
    positionEarlyChargePct: Number(rule.positionEarlyChargePct ?? 0.1),
    positionLateCompensationPct: Number(rule.positionLateCompensationPct ?? 0.03),
    swapFactor: Number(rule.swapFactor),
    swapDiscountRate: Number(rule.swapDiscountRate),
    feeFloorAmount: Number(rule.feeFloorAmount || 0),
    maxSwapsPerPlan: Number(rule.maxSwapsPerPlan),
    missedPaymentCredits: Number(rule.missedPaymentCredits),
    postPayoutMissedPenaltyMultiplier: Number(rule.postPayoutMissedPenaltyMultiplier || 2),
    contributionsCountryCode: String(rule.contributionsCountryCode || "GB").toUpperCase(),
    contributionsEnabledPaymentMethods: enabledPaymentMethods,
    pauseFeatureEnabled: Boolean(rule.pauseFeatureEnabled),
    pauseFeePerMonth: Number(rule.pauseFeePerMonth || 0),
    maxPauseMonths: Number(rule.maxPauseMonths || 0),
    updatedAt: rule.createdAt,
  };
}

exports.getCurrentRuleConfig = async (req, res) => {
  try {
    const rule = await getLatestRule();
    if (!rule) {
      return res.status(404).json({
        error: {
          code: "RULE_CONFIG_MISSING",
          message: "No rule config found. Seed a rule config first.",
        },
      });
    }
    return res.json({ rule: toRuleResponse(rule) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.updateCurrentRuleConfig = async (req, res) => {
  try {
    const parsed = updateRuleSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid rule config payload.",
          details: parsed.error.flatten(),
        },
      });
    }

    const current = await getLatestRule();
    if (!current) {
      return res.status(404).json({
        error: {
          code: "RULE_CONFIG_MISSING",
          message: "No rule config found. Seed a rule config first.",
        },
      });
    }

    const normalizedData = {
      ...parsed.data,
      ...(parsed.data.contributionsCountryCode
        ? { contributionsCountryCode: parsed.data.contributionsCountryCode.toUpperCase() }
        : {}),
    };

    const updated = await prisma.ruleConfig.update({
      where: { id: current.id },
      data: normalizedData,
    });

    return res.json({
      ok: true,
      message: "Rule config updated successfully.",
      rule: toRuleResponse(updated),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
