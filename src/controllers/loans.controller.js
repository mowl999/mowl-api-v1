const { prisma } = require("../db");

const LOAN_TYPES = new Set([
  "DISBURSEMENT",
  "REPAYMENT",
  "INTEREST_CHARGE",
  "FEE",
  "WAIVER",
  "ADJUSTMENT",
]);
const DIRECTIONS = new Set(["DEBIT", "CREDIT"]);

exports.createLoanTransaction = async (req, res) => {
  try {
    const userId = req.user?.id;
    const type = String(req.body?.type || "").toUpperCase();
    const direction = String(req.body?.direction || "").toUpperCase();
    const amount = Number(req.body?.amount);
    const currency = String(req.body?.currency || "GBP").toUpperCase();
    const reference = req.body?.reference ? String(req.body.reference).trim() : null;
    const note = req.body?.note ? String(req.body.note).trim() : null;

    if (!LOAN_TYPES.has(type)) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid loan transaction type." } });
    }
    if (!DIRECTIONS.has(direction)) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "direction must be DEBIT or CREDIT." } });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "amount must be greater than 0." } });
    }

    const tx = await prisma.loanTransaction.create({
      data: {
        userId,
        type,
        direction,
        amount,
        currency,
        reference,
        note,
      },
    });

    return res.status(201).json({ item: tx });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listLoanTransactions = async (req, res) => {
  try {
    const userId = req.user?.id;
    const items = await prisma.loanTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return res.json({ items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

