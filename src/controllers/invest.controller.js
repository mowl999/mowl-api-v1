const { prisma } = require("../db");

const DEFAULT_PRODUCTS = [
  {
    key: "LONG_TERM",
    name: "Long-Term Growth",
    description: "Long horizon wealth-building plan.",
    annualRatePct: 9.5,
    minMonths: 12,
    maxMonths: 240,
    currency: "GBP",
  },
  {
    key: "SHORT_TERM",
    name: "Short-Term Savings",
    description: "Near-term target savings plan.",
    annualRatePct: 6.5,
    minMonths: 3,
    maxMonths: 24,
    currency: "GBP",
  },
  {
    key: "RETIREMENT",
    name: "Retirement Plan",
    description: "Retirement-focused monthly investing plan.",
    annualRatePct: 8.5,
    minMonths: 24,
    maxMonths: 360,
    currency: "GBP",
  },
  {
    key: "LEGACY",
    name: "Will & Legacy Plan",
    description: "Legacy and wealth transfer preparation plan.",
    annualRatePct: 7.25,
    minMonths: 12,
    maxMonths: 240,
    currency: "GBP",
  },
  {
    key: "CHILDREN_FUTURE",
    name: "Children Future Plan",
    description: "Education and future milestone funding plan.",
    annualRatePct: 7.75,
    minMonths: 12,
    maxMonths: 216,
    currency: "GBP",
  },
];

function assertInvestModelsReady() {
  if (!prisma.investmentProduct || !prisma.investmentPlan) {
    const err = new Error(
      "Investment module not ready. Run Prisma migration and regenerate client."
    );
    err.status = 503;
    err.code = "INVESTMENT_SCHEMA_NOT_READY";
    throw err;
  }
}

function round2(n) {
  return Number(Number(n || 0).toFixed(2));
}

function monthsElapsed(startDate, endDate = new Date()) {
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (e < s) return 0;
  const yearDiff = e.getFullYear() - s.getFullYear();
  const monthDiff = e.getMonth() - s.getMonth();
  let elapsed = yearDiff * 12 + monthDiff + 1;
  if (e.getDate() < s.getDate()) elapsed -= 1;
  return Math.max(0, elapsed);
}

function projectRecurring(monthlyContribution, months, annualRatePct) {
  const monthly = Number(monthlyContribution || 0);
  const r = Number(annualRatePct || 0) / 100 / 12;
  let balance = 0;
  let totalContributed = 0;
  for (let i = 0; i < months; i += 1) {
    totalContributed += monthly;
    balance = (balance + monthly) * (1 + r);
  }
  return {
    totalContributed: round2(totalContributed),
    balance: round2(balance),
    growth: round2(balance - totalContributed),
  };
}

async function ensureDefaultProducts() {
  assertInvestModelsReady();
  const count = await prisma.investmentProduct.count();
  if (count > 0) return;
  await prisma.investmentProduct.createMany({ data: DEFAULT_PRODUCTS, skipDuplicates: true });
}

async function listProductsCore(includeInactive = false) {
  await ensureDefaultProducts();
  return prisma.investmentProduct.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      annualRatePct: true,
      minMonths: true,
      maxMonths: true,
      currency: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

async function getUserRateOverrideMap(userId) {
  if (!userId) return new Map();
  const items = await prisma.investmentUserRate.findMany({
    where: { userId, isActive: true },
    select: { productId: true, annualRatePct: true },
  });
  return new Map(items.map((x) => [x.productId, Number(x.annualRatePct)]));
}

function buildPlanSnapshot(plan) {
  const elapsed = Math.min(plan.durationMonths, monthsElapsed(plan.startDate));
  const current = projectRecurring(plan.monthlyContribution, elapsed, plan.annualRatePct);
  const maturity = projectRecurring(plan.monthlyContribution, plan.durationMonths, plan.annualRatePct);
  const monthsRemaining = Math.max(0, plan.durationMonths - elapsed);

  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    productId: plan.productId,
    productKey: plan.product.key,
    productName: plan.product.name,
    currency: plan.currency,
    monthlyContribution: round2(plan.monthlyContribution),
    durationMonths: plan.durationMonths,
    annualRatePct: round2(plan.annualRatePct),
    startDate: plan.startDate,
    createdAt: plan.createdAt,
    monthsElapsed: elapsed,
    monthsRemaining,
    progressPct: round2((elapsed / Math.max(1, plan.durationMonths)) * 100),
    totalContributed: current.totalContributed,
    currentBalance: current.balance,
    growthToDate: current.growth,
    projectedMaturityValue: maturity.balance,
    projectedTotalGrowth: maturity.growth,
  };
}

exports.listProducts = async (_req, res) => {
  try {
    assertInvestModelsReady();
    const userId = _req.user?.id;
    const [items, overrideMap] = await Promise.all([listProductsCore(false), getUserRateOverrideMap(userId)]);
    const out = items.map((x) => ({
      ...x,
      effectiveAnnualRatePct: overrideMap.has(x.id) ? Number(overrideMap.get(x.id)) : Number(x.annualRatePct),
      hasUserOverride: overrideMap.has(x.id),
    }));
    return res.json({ items: out });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.createPlan = async (req, res) => {
  try {
    assertInvestModelsReady();
    const userId = req.user?.id;
    const { productId, name, monthlyContribution, durationMonths } = req.body || {};
    const monthly = Number(monthlyContribution);
    const duration = Number(durationMonths);
    const planName = String(name || "").trim();

    if (!productId || typeof productId !== "string") {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "productId is required." } });
    }
    if (!planName || planName.length < 3) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "name must be at least 3 characters." } });
    }
    if (!Number.isFinite(monthly) || monthly <= 0) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "monthlyContribution must be > 0." } });
    }
    if (!Number.isInteger(duration) || duration < 3 || duration > 360) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "durationMonths must be an integer between 3 and 360." },
      });
    }

    await ensureDefaultProducts();
    const product = await prisma.investmentProduct.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Investment product not found." } });
    }
    if (duration < product.minMonths || duration > product.maxMonths) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: `durationMonths must be between ${product.minMonths} and ${product.maxMonths} for this product.`,
        },
      });
    }

    const userOverride = await prisma.investmentUserRate.findUnique({
      where: { userId_productId: { userId, productId: product.id } },
      select: { annualRatePct: true, isActive: true },
    });
    const effectiveRate = userOverride?.isActive ? Number(userOverride.annualRatePct) : Number(product.annualRatePct);

    const created = await prisma.investmentPlan.create({
      data: {
        userId,
        productId: product.id,
        name: planName,
        monthlyContribution: monthly,
        durationMonths: duration,
        annualRatePct: effectiveRate,
        currency: product.currency,
      },
      include: {
        product: { select: { id: true, key: true, name: true } },
      },
    });

    return res.status(201).json({ plan: buildPlanSnapshot(created) });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.listPlans = async (req, res) => {
  try {
    assertInvestModelsReady();
    const userId = req.user?.id;
    const items = await prisma.investmentPlan.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { product: { select: { id: true, key: true, name: true } } },
    });
    return res.json({ items: items.map(buildPlanSnapshot) });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.getInvestDashboard = async (req, res) => {
  try {
    assertInvestModelsReady();
    const userId = req.user?.id;
    await ensureDefaultProducts();

    const [products, plansRaw] = await Promise.all([
      prisma.investmentProduct.findMany({
        where: { isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, key: true, name: true, annualRatePct: true, currency: true },
      }),
      prisma.investmentPlan.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { product: { select: { id: true, key: true, name: true } } },
      }),
    ]);

    const plans = plansRaw.map(buildPlanSnapshot);

    const balancesByProduct = new Map();
    for (const p of products) {
      balancesByProduct.set(p.key, {
        productId: p.id,
        productKey: p.key,
        productName: p.name,
        annualRatePct: round2(p.annualRatePct),
        currency: p.currency,
        currentBalance: 0,
        totalContributed: 0,
        plansCount: 0,
        activePlans: 0,
      });
    }

    for (const plan of plans) {
      const row = balancesByProduct.get(plan.productKey);
      if (!row) continue;
      row.currentBalance = round2(row.currentBalance + plan.currentBalance);
      row.totalContributed = round2(row.totalContributed + plan.totalContributed);
      row.plansCount += 1;
      if (plan.status === "ACTIVE") row.activePlans += 1;
    }

    const productBalances = Array.from(balancesByProduct.values());

    const summary = plans.reduce(
      (acc, p) => {
        acc.totalPlans += 1;
        if (p.status === "ACTIVE") acc.activePlans += 1;
        if (p.status === "COMPLETED") acc.completedPlans += 1;
        acc.totalContributed += p.totalContributed;
        acc.currentBalance += p.currentBalance;
        acc.projectedMaturityValue += p.projectedMaturityValue;
        return acc;
      },
      {
        totalPlans: 0,
        activePlans: 0,
        completedPlans: 0,
        totalContributed: 0,
        currentBalance: 0,
        projectedMaturityValue: 0,
      }
    );

    summary.totalContributed = round2(summary.totalContributed);
    summary.currentBalance = round2(summary.currentBalance);
    summary.projectedMaturityValue = round2(summary.projectedMaturityValue);

    return res.json({
      products,
      productBalances,
      summary,
      plans,
    });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.getInvestReports = async (req, res) => {
  try {
    assertInvestModelsReady();
    const userId = req.user?.id;
    const months = Math.max(3, Math.min(24, Number(req.query.months) || 6));
    const now = new Date();

    const plansRaw = await prisma.investmentPlan.findMany({
      where: { userId },
      include: { product: { select: { key: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    const plans = plansRaw.map(buildPlanSnapshot);

    const trend = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      trend.push({ month, contributed: 0, growth: 0, plansCreated: 0 });
    }
    const trendByMonth = new Map(trend.map((t) => [t.month, t]));

    for (const p of plans) {
      const createdMonth = `${new Date(p.createdAt).getFullYear()}-${String(new Date(p.createdAt).getMonth() + 1).padStart(2, "0")}`;
      if (trendByMonth.has(createdMonth)) {
        trendByMonth.get(createdMonth).plansCreated += 1;
      }

      for (let m = 0; m < p.monthsElapsed; m += 1) {
        const monthDate = new Date(new Date(p.startDate).getFullYear(), new Date(p.startDate).getMonth() + m, 1);
        const mk = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
        const row = trendByMonth.get(mk);
        if (!row) continue;
        row.contributed = round2(row.contributed + p.monthlyContribution);
      }

      // Approximate growth allocation for window.
      const monthlyGrowth = p.monthsElapsed > 0 ? p.growthToDate / p.monthsElapsed : 0;
      for (let m = 0; m < p.monthsElapsed; m += 1) {
        const monthDate = new Date(new Date(p.startDate).getFullYear(), new Date(p.startDate).getMonth() + m, 1);
        const mk = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
        const row = trendByMonth.get(mk);
        if (!row) continue;
        row.growth = round2(row.growth + monthlyGrowth);
      }
    }

    const productPlanMix = {};
    for (const p of plans) {
      const k = p.productKey;
      if (!productPlanMix[k]) {
        productPlanMix[k] = { productKey: k, productName: p.productName, plansCount: 0, currentBalance: 0 };
      }
      productPlanMix[k].plansCount += 1;
      productPlanMix[k].currentBalance = round2(productPlanMix[k].currentBalance + p.currentBalance);
    }

    return res.json({
      months,
      trend: trend.map((t) => ({ ...t, contributed: round2(t.contributed), growth: round2(t.growth) })),
      productPlanMix: Object.values(productPlanMix),
    });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.adminListProducts = async (_req, res) => {
  try {
    assertInvestModelsReady();
    const items = await listProductsCore(true);
    return res.json({ items });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.adminListUserRates = async (req, res) => {
  try {
    assertInvestModelsReady();
    const userId = String(req.query.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "userId is required." } });
    }
    const items = await prisma.investmentUserRate.findMany({
      where: { userId },
      include: {
        product: {
          select: { id: true, key: true, name: true, annualRatePct: true, currency: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return res.json({ items });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.adminUpsertUserRate = async (req, res) => {
  try {
    assertInvestModelsReady();
    const userId = String(req.body?.userId || "").trim();
    const productId = String(req.body?.productId || "").trim();
    const annualRatePct = Number(req.body?.annualRatePct);
    const isActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : true;

    if (!userId || !productId) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "userId and productId are required." } });
    }
    if (!Number.isFinite(annualRatePct) || annualRatePct < 0 || annualRatePct > 100) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "annualRatePct must be between 0 and 100." } });
    }

    const [user, product] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } }),
      prisma.investmentProduct.findUnique({ where: { id: productId }, select: { id: true } }),
    ]);
    if (!user || user.role !== "USER") {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    }
    if (!product) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Investment product not found." } });
    }

    const result = await prisma.$transaction(async (tx) => {
      const rate = await tx.investmentUserRate.upsert({
        where: { userId_productId: { userId, productId } },
        update: { annualRatePct, isActive },
        create: { userId, productId, annualRatePct, isActive },
        include: {
          product: { select: { id: true, key: true, name: true, annualRatePct: true, currency: true } },
        },
      });

      if (isActive) {
        await tx.investmentPlan.updateMany({
          where: { userId, productId, status: "ACTIVE" },
          data: { annualRatePct },
        });
      } else {
        // Revert active plans to product base rate when override is disabled.
        const baseRate = Number(rate.product.annualRatePct);
        await tx.investmentPlan.updateMany({
          where: { userId, productId, status: "ACTIVE" },
          data: { annualRatePct: baseRate },
        });
      }
      return rate;
    });

    return res.json({ item: result });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.adminCreateProduct = async (req, res) => {
  try {
    assertInvestModelsReady();
    const {
      key,
      name,
      description,
      annualRatePct,
      minMonths = 3,
      maxMonths = 240,
      currency = "GBP",
      isActive = true,
    } = req.body || {};

    if (!key || !name) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "key and name are required." } });
    }
    const rate = Number(annualRatePct);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "annualRatePct must be between 0 and 100." } });
    }

    const created = await prisma.investmentProduct.create({
      data: {
        key: String(key).toUpperCase(),
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        annualRatePct: rate,
        minMonths: Number(minMonths),
        maxMonths: Number(maxMonths),
        currency: String(currency).toUpperCase(),
        isActive: Boolean(isActive),
      },
    });
    return res.status(201).json({ product: created });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.adminUpdateProduct = async (req, res) => {
  try {
    assertInvestModelsReady();
    const { productId } = req.params;
    const patch = {};
    const b = req.body || {};

    if (b.name !== undefined) patch.name = String(b.name).trim();
    if (b.description !== undefined) patch.description = b.description ? String(b.description).trim() : null;
    if (b.annualRatePct !== undefined) patch.annualRatePct = Number(b.annualRatePct);
    if (b.minMonths !== undefined) patch.minMonths = Number(b.minMonths);
    if (b.maxMonths !== undefined) patch.maxMonths = Number(b.maxMonths);
    if (b.currency !== undefined) patch.currency = String(b.currency).toUpperCase();
    if (b.isActive !== undefined) patch.isActive = Boolean(b.isActive);

    if (patch.annualRatePct !== undefined && (!Number.isFinite(patch.annualRatePct) || patch.annualRatePct < 0 || patch.annualRatePct > 100)) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "annualRatePct must be between 0 and 100." } });
    }

    const updated = await prisma.investmentProduct.update({
      where: { id: productId },
      data: patch,
    });
    return res.json({ product: updated });
  } catch (err) {
    console.error(err);
    if (err?.code === "INVESTMENT_SCHEMA_NOT_READY") {
      return res.status(err.status || 503).json({
        error: {
          code: err.code,
          message:
            "Investment module schema not available yet. Run Prisma migration and restart API.",
        },
      });
    }
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
