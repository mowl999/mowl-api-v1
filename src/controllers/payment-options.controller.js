const { prisma } = require("../db");

function normalizeEnabledMethods(raw) {
  if (!Array.isArray(raw)) return ["CARD", "PAY_BY_BANK", "DIRECT_DEBIT", "BANK_TRANSFER_MANUAL"];
  const allowed = new Set(["CARD", "PAY_BY_BANK", "DIRECT_DEBIT", "BANK_TRANSFER_MANUAL"]);
  const out = raw.filter((x) => allowed.has(String(x)));
  return out.length > 0 ? out : ["CARD", "PAY_BY_BANK", "DIRECT_DEBIT", "BANK_TRANSFER_MANUAL"];
}

function buildMethodMeta(code, countryCode) {
  if (code === "CARD") {
    return {
      code,
      label: "Card (Visa/Mastercard)",
      description:
        countryCode === "GB"
          ? "Pay instantly with card, Apple Pay, or Google Pay."
          : "Pay instantly with your card.",
      submissionMode: "GATEWAY",
      availableNow: true,
    };
  }
  if (code === "PAY_BY_BANK") {
    return {
      code,
      label: countryCode === "GB" ? "Pay by Bank (Open Banking)" : "Pay by Bank",
      description:
        countryCode === "GB"
          ? "Instant bank payment via your UK banking app."
          : "Instant bank payment from your account.",
      submissionMode: "GATEWAY",
      availableNow: true,
    };
  }
  if (code === "DIRECT_DEBIT") {
    return {
      code,
      label: countryCode === "GB" ? "Direct Debit (Bacs)" : "Direct Debit",
      description: "Best for recurring monthly collections.",
      submissionMode: "UNAVAILABLE",
      availableNow: false,
    };
  }
  return {
    code: "BANK_TRANSFER_MANUAL",
    label: "Manual Bank Transfer",
    description: "Transfer manually and submit reference for admin review.",
    submissionMode: "BANK_TRANSFER",
    availableNow: true,
  };
}

exports.getPlanPaymentOptions = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { planId } = req.params;

    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      select: {
        id: true,
        userId: true,
        currency: true,
        ruleConfig: {
          select: {
            contributionsCountryCode: true,
            contributionsEnabledPaymentMethods: true,
          },
        },
      },
    });

    if (!plan) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Plan not found." } });
    if (plan.userId !== userId) return res.status(403).json({ error: { code: "FORBIDDEN", message: "No access." } });

    const countryCode = String(plan.ruleConfig?.contributionsCountryCode || "GB").toUpperCase();
    const enabled = normalizeEnabledMethods(plan.ruleConfig?.contributionsEnabledPaymentMethods);
    const methods = enabled.map((code) => buildMethodMeta(code, countryCode));

    return res.json({
      planId: plan.id,
      countryCode,
      currency: plan.currency,
      methods,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
