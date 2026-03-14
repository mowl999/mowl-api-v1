const { prisma } = require("../db");

function parseDate(value, field) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw { status: 400, code: "VALIDATION_ERROR", message: `${field} must be a valid ISO date.` };
  }
  return d;
}

function resolveRange(query) {
  const now = new Date();
  const start = query.startDate ? parseDate(query.startDate, "startDate") : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const end = query.endDate ? parseDate(query.endDate, "endDate") : now;
  if (start > end) {
    throw { status: 400, code: "VALIDATION_ERROR", message: "startDate cannot be after endDate." };
  }
  return { start, end };
}

function escCsv(v) {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  return [headers.map(escCsv).join(","), ...rows.map((r) => r.map(escCsv).join(","))].join("\n");
}

function sendCsv(res, filename, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}

function buildEmptyStatement(product, start, end) {
  return {
    product,
    period: { startDate: start.toISOString(), endDate: end.toISOString() },
    generatedAt: new Date().toISOString(),
    summary: {
      totalCredits: 0,
      totalDebits: 0,
      net: 0,
      openingBalance: 0,
      closingBalance: 0,
    },
    rows: [],
  };
}

function maybeSendCsv(res, productKey, start, end, format, statement) {
  if (format !== "csv") return false;
  const headers = [
    "Date",
    "Product",
    "Activity Type",
    "Reference",
    "Plan ID",
    "Plan Name",
    "Direction",
    "Amount",
    "Currency",
    "Description",
    "Balance After",
  ];
  const csv = toCsv(
    headers,
    (statement.rows || []).map((r) => [
      r.date,
      r.product,
      r.activityType,
      r.reference,
      r.planId,
      r.planName,
      r.direction,
      r.amount,
      r.currency,
      r.description,
      r.runningBalance,
    ])
  );
  sendCsv(
    res,
    `${productKey}-statement-${start.toISOString().slice(0, 10)}-to-${end.toISOString().slice(0, 10)}.csv`,
    csv
  );
  return true;
}

exports.getMyContributionsStatement = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { start, end } = resolveRange(req.query || {});
    const format = String(req.query.format || "json").toLowerCase();

    const [contributions, payouts, swaps, pauses] = await Promise.all([
      prisma.contribution.findMany({
        where: {
          userId,
          createdAt: { lte: end },
          status: { in: ["PAID", "LATE"] },
        },
        include: {
          plan: { select: { id: true, name: true, currency: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.payout.findMany({
        where: {
          status: "SENT",
          recipientType: "REAL",
          createdAt: { lte: end },
          plan: { userId },
        },
        include: {
          plan: { select: { id: true, name: true, currency: true } },
        },
        orderBy: { sentAt: "asc" },
      }),
      prisma.swap.findMany({
        where: {
          userId,
          status: "APPROVED",
          createdAt: { lte: end },
        },
        include: {
          plan: { select: { id: true, name: true, currency: true } },
        },
        orderBy: { reviewedAt: "asc" },
      }),
      prisma.planPause.findMany({
        where: {
          userId,
          status: "APPROVED",
          createdAt: { lte: end },
        },
        include: {
          plan: { select: { id: true, name: true, currency: true } },
        },
        orderBy: { reviewedAt: "asc" },
      }),
    ]);

    const allRows = [];
    for (const c of contributions) {
      const eventDate = c.paidAt || c.createdAt;
      allRows.push({
        date: eventDate.toISOString(),
        ts: eventDate.getTime(),
        product: "MYCONTRIBUTIONS",
        activityType: "CONTRIBUTION_PAYMENT",
        reference: c.id,
        planId: c.planId,
        planName: c.plan?.name || "",
        direction: "DEBIT",
        amount: Number(c.amount || 0),
        currency: c.plan?.currency || "GBP",
        description: `Contribution (${c.status}) for ${c.plan?.name || "plan"}`,
      });
    }
    for (const p of payouts) {
      const eventDate = p.sentAt || p.createdAt;
      allRows.push({
        date: eventDate.toISOString(),
        ts: eventDate.getTime(),
        product: "MYCONTRIBUTIONS",
        activityType: "PAYOUT_RECEIVED",
        reference: p.id,
        planId: p.planId,
        planName: p.plan?.name || "",
        direction: "CREDIT",
        amount: Number(p.amount || 0),
        currency: p.currency || p.plan?.currency || "GBP",
        description: `Payout received for ${p.plan?.name || "plan"}`,
      });
    }
    for (const s of swaps) {
      const eventDate = s.reviewedAt || s.createdAt;
      allRows.push({
        date: eventDate.toISOString(),
        ts: eventDate.getTime(),
        product: "MYCONTRIBUTIONS",
        activityType: "SWAP_FEE",
        reference: s.id,
        planId: s.planId,
        planName: s.plan?.name || "",
        direction: "DEBIT",
        amount: Number(s.feeCharged || 0),
        currency: s.plan?.currency || "GBP",
        description: `Position swap fee (${s.fromPosition} -> ${s.toPosition})`,
      });
    }
    for (const p of pauses) {
      const eventDate = p.reviewedAt || p.createdAt;
      allRows.push({
        date: eventDate.toISOString(),
        ts: eventDate.getTime(),
        product: "MYCONTRIBUTIONS",
        activityType: "PAUSE_FEE",
        reference: p.id,
        planId: p.planId,
        planName: p.plan?.name || "",
        direction: "DEBIT",
        amount: Number(p.totalFee || 0),
        currency: p.plan?.currency || "GBP",
        description: `Pause fee (${p.months} month(s))`,
      });
    }

    allRows.sort((a, b) => a.ts - b.ts);
    const startTs = start.getTime();
    const openingBalance = Number(
      allRows
        .filter((r) => r.ts < startTs)
        .reduce((sum, r) => sum + (r.direction === "CREDIT" ? r.amount : -r.amount), 0)
        .toFixed(2)
    );
    const periodRowsRaw = allRows.filter((r) => r.ts >= startTs);
    let running = openingBalance;
    const rows = periodRowsRaw.map((r) => {
      running = Number((running + (r.direction === "CREDIT" ? r.amount : -r.amount)).toFixed(2));
      const { ts, ...rest } = r;
      return { ...rest, runningBalance: running };
    });

    const summary = rows.reduce(
      (acc, r) => {
        if (r.direction === "CREDIT") acc.totalCredits += r.amount;
        if (r.direction === "DEBIT") acc.totalDebits += r.amount;
        return acc;
      },
      { totalCredits: 0, totalDebits: 0 }
    );
    summary.totalCredits = Number(summary.totalCredits.toFixed(2));
    summary.totalDebits = Number(summary.totalDebits.toFixed(2));
    const net = Number((summary.totalCredits - summary.totalDebits).toFixed(2));

    if (format === "csv") {
      const headers = [
        "Date",
        "Product",
        "Activity Type",
        "Reference",
        "Plan ID",
        "Plan Name",
        "Direction",
        "Amount",
        "Currency",
        "Description",
      ];
      const csv = toCsv(
        [...headers, "Balance After"],
        rows.map((r) => [
          r.date,
          r.product,
          r.activityType,
          r.reference,
          r.planId,
          r.planName,
          r.direction,
          r.amount,
          r.currency,
          r.description,
          r.runningBalance,
        ])
      );
      return sendCsv(res, `mycontributions-statement-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    }

    return res.json({
      product: "MYCONTRIBUTIONS",
      period: { startDate: start.toISOString(), endDate: end.toISOString() },
      generatedAt: new Date().toISOString(),
      summary: { ...summary, net, openingBalance, closingBalance: rows.length ? rows[rows.length - 1].runningBalance : openingBalance },
      rows,
    });
  } catch (err) {
    console.error(err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: {
        code: err?.code || "SERVER_ERROR",
        message: err?.message || "Something went wrong.",
      },
    });
  }
};

function monthsElapsed(startDate, endDate = new Date()) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (e < s) return 0;
  const y = e.getFullYear() - s.getFullYear();
  const m = e.getMonth() - s.getMonth();
  let elapsed = y * 12 + m + 1;
  if (e.getDate() < s.getDate()) elapsed -= 1;
  return Math.max(0, elapsed);
}

function addMonths(date, count) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + count);
  return d;
}

exports.getMyInvestmentStatement = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { start, end } = resolveRange(req.query || {});
    const format = String(req.query.format || "json").toLowerCase();

    const plans = await prisma.investmentPlan.findMany({
      where: { userId },
      include: {
        product: { select: { id: true, key: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const allRows = [];
    for (const p of plans) {
      const elapsed = Math.min(p.durationMonths, monthsElapsed(p.startDate, end));
      const r = Number(p.annualRatePct || 0) / 100 / 12;
      let runningBalance = 0;
      for (let i = 0; i < elapsed; i += 1) {
        const cycleDate = addMonths(p.startDate, i);
        if (cycleDate > end) continue;

        const contribution = Number(p.monthlyContribution || 0);
        allRows.push({
          date: cycleDate.toISOString(),
          ts: cycleDate.getTime(),
          product: "MYINVESTMENT",
          activityType: "INVESTMENT_CONTRIBUTION",
          reference: `${p.id}-M${i + 1}-C`,
          planId: p.id,
          planName: p.name,
          direction: "DEBIT",
          amount: Number(contribution.toFixed(2)),
          currency: p.currency || "GBP",
          description: `${p.product?.name || "Investment"} monthly contribution`,
        });

        const growth = Number(((runningBalance + contribution) * r).toFixed(2));
        runningBalance = Number((runningBalance + contribution + growth).toFixed(2));
        if (growth !== 0) {
          allRows.push({
            date: cycleDate.toISOString(),
            ts: cycleDate.getTime(),
            product: "MYINVESTMENT",
            activityType: "INVESTMENT_GROWTH",
            reference: `${p.id}-M${i + 1}-G`,
            planId: p.id,
            planName: p.name,
            direction: "CREDIT",
            amount: growth,
            currency: p.currency || "GBP",
            description: `${p.product?.name || "Investment"} periodic growth`,
          });
        }
      }
    }

    allRows.sort((a, b) => a.ts - b.ts);
    const startTs = start.getTime();
    const openingBalance = Number(
      allRows
        .filter((r) => r.ts < startTs)
        .reduce((sum, r) => sum + (r.direction === "CREDIT" ? r.amount : -r.amount), 0)
        .toFixed(2)
    );
    const periodRowsRaw = allRows.filter((r) => r.ts >= startTs);
    let running = openingBalance;
    const rows = periodRowsRaw.map((r) => {
      running = Number((running + (r.direction === "CREDIT" ? r.amount : -r.amount)).toFixed(2));
      const { ts, ...rest } = r;
      return { ...rest, runningBalance: running };
    });

    const summary = rows.reduce(
      (acc, r) => {
        if (r.direction === "CREDIT") acc.totalCredits += r.amount;
        if (r.direction === "DEBIT") acc.totalDebits += r.amount;
        return acc;
      },
      { totalCredits: 0, totalDebits: 0 }
    );
    summary.totalCredits = Number(summary.totalCredits.toFixed(2));
    summary.totalDebits = Number(summary.totalDebits.toFixed(2));
    const net = Number((summary.totalCredits - summary.totalDebits).toFixed(2));

    if (format === "csv") {
      const headers = [
        "Date",
        "Product",
        "Activity Type",
        "Reference",
        "Plan ID",
        "Plan Name",
        "Direction",
        "Amount",
        "Currency",
        "Description",
      ];
      const csv = toCsv(
        [...headers, "Balance After"],
        rows.map((r) => [
          r.date,
          r.product,
          r.activityType,
          r.reference,
          r.planId,
          r.planName,
          r.direction,
          r.amount,
          r.currency,
          r.description,
          r.runningBalance,
        ])
      );
      return sendCsv(res, `myinvestment-statement-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    }

    return res.json({
      product: "MYINVESTMENT",
      period: { startDate: start.toISOString(), endDate: end.toISOString() },
      generatedAt: new Date().toISOString(),
      summary: { ...summary, net, openingBalance, closingBalance: rows.length ? rows[rows.length - 1].runningBalance : openingBalance },
      rows,
    });
  } catch (err) {
    console.error(err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: {
        code: err?.code || "SERVER_ERROR",
        message: err?.message || "Something went wrong.",
      },
    });
  }
};

exports.getMyLoanStatement = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { start, end } = resolveRange(req.query || {});
    const format = String(req.query.format || "json").toLowerCase();
    const txs = await prisma.loanTransaction.findMany({
      where: { userId, createdAt: { lte: end } },
      orderBy: { createdAt: "asc" },
    });
    const allRows = txs.map((t) => ({
      date: t.createdAt.toISOString(),
      ts: t.createdAt.getTime(),
      product: "MYLOAN",
      activityType: t.type,
      reference: t.reference || t.id,
      planId: "",
      planName: "",
      direction: t.direction,
      amount: Number(t.amount || 0),
      currency: t.currency || "GBP",
      description: t.note || `Loan transaction: ${t.type}`,
    }));

    const startTs = start.getTime();
    const openingBalance = Number(
      allRows
        .filter((r) => r.ts < startTs)
        .reduce((sum, r) => sum + (r.direction === "CREDIT" ? r.amount : -r.amount), 0)
        .toFixed(2)
    );
    const periodRowsRaw = allRows.filter((r) => r.ts >= startTs);
    let running = openingBalance;
    const rows = periodRowsRaw.map((r) => {
      running = Number((running + (r.direction === "CREDIT" ? r.amount : -r.amount)).toFixed(2));
      const { ts, ...rest } = r;
      return { ...rest, runningBalance: running };
    });
    const summary = rows.reduce(
      (acc, r) => {
        if (r.direction === "CREDIT") acc.totalCredits += r.amount;
        if (r.direction === "DEBIT") acc.totalDebits += r.amount;
        return acc;
      },
      { totalCredits: 0, totalDebits: 0 }
    );
    summary.totalCredits = Number(summary.totalCredits.toFixed(2));
    summary.totalDebits = Number(summary.totalDebits.toFixed(2));
    const net = Number((summary.totalCredits - summary.totalDebits).toFixed(2));
    const statement = {
      product: "MYLOAN",
      period: { startDate: start.toISOString(), endDate: end.toISOString() },
      generatedAt: new Date().toISOString(),
      summary: {
        ...summary,
        net,
        openingBalance,
        closingBalance: rows.length ? rows[rows.length - 1].runningBalance : openingBalance,
      },
      rows,
    };
    if (maybeSendCsv(res, "myloan", start, end, format, statement)) return;
    return res.json(statement);
  } catch (err) {
    console.error(err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: {
        code: err?.code || "SERVER_ERROR",
        message: err?.message || "Something went wrong.",
      },
    });
  }
};

exports.getMyFundTransfersStatement = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { start, end } = resolveRange(req.query || {});
    const format = String(req.query.format || "json").toLowerCase();
    const txs = await prisma.fundTransferTransaction.findMany({
      where: { userId, createdAt: { lte: end } },
      orderBy: { createdAt: "asc" },
    });
    const allRows = txs.map((t) => ({
      date: t.createdAt.toISOString(),
      ts: t.createdAt.getTime(),
      product: "MYFUNDTRANSFERS",
      activityType: t.type,
      reference: t.reference || t.id,
      planId: "",
      planName: "",
      direction: t.direction,
      amount: Number(t.amount || 0),
      currency: t.currency || "GBP",
      description: t.note || `Fund transfer transaction: ${t.type}`,
    }));
    const startTs = start.getTime();
    const openingBalance = Number(
      allRows
        .filter((r) => r.ts < startTs)
        .reduce((sum, r) => sum + (r.direction === "CREDIT" ? r.amount : -r.amount), 0)
        .toFixed(2)
    );
    const periodRowsRaw = allRows.filter((r) => r.ts >= startTs);
    let running = openingBalance;
    const rows = periodRowsRaw.map((r) => {
      running = Number((running + (r.direction === "CREDIT" ? r.amount : -r.amount)).toFixed(2));
      const { ts, ...rest } = r;
      return { ...rest, runningBalance: running };
    });
    const summary = rows.reduce(
      (acc, r) => {
        if (r.direction === "CREDIT") acc.totalCredits += r.amount;
        if (r.direction === "DEBIT") acc.totalDebits += r.amount;
        return acc;
      },
      { totalCredits: 0, totalDebits: 0 }
    );
    summary.totalCredits = Number(summary.totalCredits.toFixed(2));
    summary.totalDebits = Number(summary.totalDebits.toFixed(2));
    const net = Number((summary.totalCredits - summary.totalDebits).toFixed(2));
    const statement = {
      product: "MYFUNDTRANSFERS",
      period: { startDate: start.toISOString(), endDate: end.toISOString() },
      generatedAt: new Date().toISOString(),
      summary: {
        ...summary,
        net,
        openingBalance,
        closingBalance: rows.length ? rows[rows.length - 1].runningBalance : openingBalance,
      },
      rows,
    };
    if (maybeSendCsv(res, "myfundtransfers", start, end, format, statement)) return;
    return res.json(statement);
  } catch (err) {
    console.error(err);
    const status = err?.status || 500;
    return res.status(status).json({
      error: {
        code: err?.code || "SERVER_ERROR",
        message: err?.message || "Something went wrong.",
      },
    });
  }
};
