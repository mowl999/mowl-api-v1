const { prisma } = require("../db");

// POST /v1/deposits/initial
exports.initialDeposit = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, currency = "GBP", paymentRef } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Amount must be greater than 0." },
      });
    }

    if (!paymentRef || String(paymentRef).trim().length < 3) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "paymentRef is required." },
      });
    }

    // Get latest rules (must exist in DB)
    const ruleConfig = await prisma.ruleConfig.findFirst({
      orderBy: { version: "desc" },
    });

    if (!ruleConfig) {
      return res.status(500).json({
        error: { code: "RULE_CONFIG_MISSING", message: "Rule config not found. Seed RuleConfig first." },
      });
    }

    if (Number(amount) < ruleConfig.minInitialDeposit) {
      return res.status(403).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Initial deposit is below minimum.",
          details: { minInitialDeposit: ruleConfig.minInitialDeposit },
        },
      });
    }

    if (!req.user || !req.user.id) {
  return res.status(401).json({
    error: { code: "UNAUTHORIZED", message: "Missing or invalid token." },
  });
}
    // Prevent duplicates
    const existing = await prisma.initialDeposit.findFirst({ where: { userId } });
    if (existing) {
      return res.status(409).json({
        error: { code: "INITIAL_DEPOSIT_ALREADY_DONE", message: "Initial deposit has already been made." },
      });
    }

    // Credits: 1 credit per £10 (or use ruleConfig.creditRatePer10)
    const creditRatePer10 = ruleConfig.creditRatePer10 ?? 1;
    const creditsAwarded = (Number(amount) / 10) * creditRatePer10;

    const lastLedger = await prisma.creditLedger.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    const prevBalance = lastLedger?.balanceAfter ?? 0;
    const newBalance = prevBalance + creditsAwarded;

    const deposit = await prisma.$transaction(async (tx) => {
      const dep = await tx.initialDeposit.create({
        data: {
          userId,
          amount: Number(amount),
          currency,
          locked: true,
          paymentRef,
        },
      });

      await tx.creditLedger.create({
        data: {
          userId,
          delta: creditsAwarded,
          balanceAfter: newBalance,
          reason: "INITIAL_DEPOSIT",
          referenceId: dep.id,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { state: "ACTIVE" },
      });

      return dep;
    });

    return res.status(201).json({
      depositId: deposit.id,
      amount: deposit.amount,
      currency: deposit.currency,
      locked: deposit.locked,
      creditsAwarded,
      userStateAfter: "ACTIVE",
      createdAt: deposit.createdAt,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Something went wrong." },
    });
  }
};
