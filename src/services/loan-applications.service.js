const DEFAULT_LOAN_PRODUCTS = [
  {
    slug: "personal-loan",
    name: "Personal Loan",
    description: "Flexible support for personal needs such as rent, family commitments, emergency expenses, or debt consolidation.",
    minAmount: 500,
    maxAmount: 15000,
    minTermMonths: 3,
    maxTermMonths: 36,
    annualInterestRatePct: 0.16,
    processingFeePct: 0.01,
    equityRequirementPct: 0.2,
    minimumEquityAmount: 250,
    currency: "GBP",
    requiredDocuments: ["IDENTITY", "EMPLOYMENT_EVIDENCE", "BANK_STATEMENT"],
  },
  {
    slug: "business-loan",
    name: "Business Loan",
    description: "Working capital or expansion support for inventory, business equipment, supplier payments, or short-term growth needs.",
    minAmount: 1000,
    maxAmount: 50000,
    minTermMonths: 3,
    maxTermMonths: 48,
    annualInterestRatePct: 0.18,
    processingFeePct: 0.015,
    equityRequirementPct: 0.3,
    minimumEquityAmount: 1000,
    currency: "GBP",
    requiredDocuments: ["IDENTITY", "BUSINESS_PROOF", "BANK_STATEMENT"],
  },
  {
    slug: "school-fees-loan",
    name: "School Fees Loan",
    description: "Structured support for tuition, resumption fees, and education-related family commitments.",
    minAmount: 300,
    maxAmount: 10000,
    minTermMonths: 3,
    maxTermMonths: 24,
    annualInterestRatePct: 0.12,
    processingFeePct: 0.005,
    equityRequirementPct: 0.15,
    minimumEquityAmount: 150,
    currency: "GBP",
    requiredDocuments: ["IDENTITY", "BANK_STATEMENT", "OTHER"],
  },
];

const baseDocumentSelect = {
  id: true,
  documentType: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedAt: true,
};

const loanApplicationInclude = {
  product: {
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      minAmount: true,
      maxAmount: true,
      minTermMonths: true,
      maxTermMonths: true,
      annualInterestRatePct: true,
      processingFeePct: true,
      equityRequirementPct: true,
      minimumEquityAmount: true,
      currency: true,
      requiredDocuments: true,
      isActive: true,
    },
  },
  documents: {
    orderBy: { uploadedAt: "desc" },
    select: baseDocumentSelect,
  },
  equityContributions: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amount: true,
      currency: true,
      channel: true,
      paymentRef: true,
      paidAt: true,
      createdAt: true,
    },
  },
  equityPayments: {
    orderBy: { submittedAt: "desc" },
    select: {
      id: true,
      amount: true,
      currency: true,
      channel: true,
      status: true,
      providerRef: true,
      userReference: true,
      receiptUrl: true,
      note: true,
      reviewNote: true,
      submittedAt: true,
      reviewedAt: true,
      reviewedById: true,
    },
  },
  repaymentPayments: {
    orderBy: { submittedAt: "desc" },
    select: {
      id: true,
      installmentId: true,
      amount: true,
      currency: true,
      channel: true,
      status: true,
      providerRef: true,
      userReference: true,
      receiptUrl: true,
      note: true,
      reviewNote: true,
      reviewedById: true,
      submittedAt: true,
      reviewedAt: true,
    },
  },
  updates: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      actorType: true,
      entryType: true,
      title: true,
      note: true,
      metadata: true,
      createdAt: true,
    },
  },
  repaymentSchedule: {
    orderBy: { installmentNumber: "asc" },
    select: {
      id: true,
      installmentNumber: true,
      dueDate: true,
      principalAmount: true,
      interestAmount: true,
      feeAmount: true,
      totalDue: true,
      amountPaid: true,
      status: true,
      paidAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  transactions: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      direction: true,
      amount: true,
      currency: true,
      reference: true,
      note: true,
      metadata: true,
      installmentId: true,
      createdAt: true,
    },
  },
  reviewedBy: {
    select: {
      id: true,
      fullName: true,
      email: true,
    },
  },
  disbursedBy: {
    select: {
      id: true,
      fullName: true,
      email: true,
    },
  },
};

const adminLoanApplicationInclude = {
  ...loanApplicationInclude,
  user: {
    select: {
      id: true,
      fullName: true,
      email: true,
      state: true,
    },
  },
};

function normalizeRequiredDocuments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

function getRequiredEquity(item) {
  const requirementPct = Number(item.product?.equityRequirementPct || 0);
  const minimumEquityAmount = Number(item.product?.minimumEquityAmount || 0);
  return Math.max(Number(item.amountRequested || 0) * requirementPct, minimumEquityAmount);
}

function getConfirmedEquity(item) {
  return (item.equityContributions || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
}

function normalizeRepaymentStatus(status, dueDate) {
  if (status !== "PENDING") return status;
  if (!dueDate) return status;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return status;
  return due.getTime() < Date.now() ? "OVERDUE" : status;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function computeInstallmentStatus({ totalDue, amountPaid, dueDate }) {
  const outstanding = roundMoney(Math.max(Number(totalDue || 0) - Number(amountPaid || 0), 0));
  if (outstanding <= 0) return "PAID";
  if (Number(amountPaid || 0) > 0) return "PARTIAL";
  return normalizeRepaymentStatus("PENDING", dueDate);
}

function addMonths(date, count) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + count);
  return next;
}

function buildRepaymentSchedule({ principal, termMonths, annualInterestRatePct, processingFeePct, firstDueDate }) {
  const normalizedPrincipal = roundMoney(principal);
  const monthlyRate = Number(annualInterestRatePct || 0) / 12;
  const totalFee = roundMoney(normalizedPrincipal * Number(processingFeePct || 0));
  const feePerInstallment = totalFee / termMonths;
  const basePayment =
    monthlyRate > 0
      ? normalizedPrincipal * (monthlyRate / (1 - Math.pow(1 + monthlyRate, -termMonths)))
      : normalizedPrincipal / termMonths;

  let remainingPrincipal = normalizedPrincipal;
  let remainingFee = totalFee;
  const installments = [];

  for (let index = 1; index <= termMonths; index += 1) {
    const isLast = index === termMonths;
    const interestAmount = roundMoney(monthlyRate > 0 ? remainingPrincipal * monthlyRate : 0);
    let principalAmount = roundMoney(isLast ? remainingPrincipal : Math.max(basePayment - interestAmount, 0));
    if (principalAmount > remainingPrincipal) principalAmount = roundMoney(remainingPrincipal);

    let feeAmount = roundMoney(isLast ? remainingFee : feePerInstallment);
    if (feeAmount > remainingFee) feeAmount = roundMoney(remainingFee);

    const totalDue = roundMoney(principalAmount + interestAmount + feeAmount);
    remainingPrincipal = roundMoney(remainingPrincipal - principalAmount);
    remainingFee = roundMoney(remainingFee - feeAmount);

    installments.push({
      installmentNumber: index,
      dueDate: addMonths(firstDueDate, index - 1),
      principalAmount,
      interestAmount,
      feeAmount,
      totalDue,
      amountPaid: 0,
      status: "PENDING",
    });
  }

  return installments;
}

async function addLoanApplicationUpdate(tx, { applicationId, actorType, entryType, title, note = null, metadata = null }) {
  return tx.loanApplicationUpdate.create({
    data: {
      applicationId,
      actorType,
      entryType,
      title,
      note,
      metadata,
    },
  });
}

async function ensureDefaultLoanProducts(prisma) {
  if (!prisma.loanProduct) return;

  const existing = await prisma.loanProduct.findMany({
    where: {
      slug: { in: DEFAULT_LOAN_PRODUCTS.map((item) => item.slug) },
    },
    select: {
      id: true,
      slug: true,
      annualInterestRatePct: true,
      processingFeePct: true,
      equityRequirementPct: true,
      minimumEquityAmount: true,
      requiredDocuments: true,
    },
  });

  const bySlug = new Map(existing.map((item) => [item.slug, item]));
  const missing = DEFAULT_LOAN_PRODUCTS.filter((item) => !bySlug.has(item.slug));
  if (missing.length) {
    await prisma.loanProduct.createMany({ data: missing });
  }

  for (const product of DEFAULT_LOAN_PRODUCTS) {
    const current = bySlug.get(product.slug);
    if (!current) continue;

    const patch = {};
    if (Number(current.annualInterestRatePct || 0) <= 0) patch.annualInterestRatePct = product.annualInterestRatePct;
    if (Number(current.processingFeePct || 0) <= 0) patch.processingFeePct = product.processingFeePct;
    if (Number(current.equityRequirementPct || 0) <= 0) patch.equityRequirementPct = product.equityRequirementPct;
    if (Number(current.minimumEquityAmount || 0) <= 0) patch.minimumEquityAmount = product.minimumEquityAmount;
    if (!Array.isArray(current.requiredDocuments) || current.requiredDocuments.length === 0) {
      patch.requiredDocuments = product.requiredDocuments;
    }

    if (Object.keys(patch).length) {
      await prisma.loanProduct.update({
        where: { id: current.id },
        data: patch,
      });
    }
  }
}

function serializeLoanApplication(item) {
  if (!item) return null;

  const requirementPct = Number(item.product?.equityRequirementPct || 0);
  const minimumEquityAmount = Number(item.product?.minimumEquityAmount || 0);
  const annualInterestRatePct = Number(item.annualInterestRatePct ?? item.product?.annualInterestRatePct ?? 0);
  const processingFeePct = Number(item.processingFeePct ?? item.product?.processingFeePct ?? 0);
  const requiredAmount = getRequiredEquity(item);
  const confirmedAmount = getConfirmedEquity(item);
  const pendingAmount = (item.equityPayments || [])
    .filter((entry) => entry.status === "SUBMITTED")
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const remainingAmount = Math.max(requiredAmount - confirmedAmount, 0);
  const progressPct = requiredAmount > 0 ? Math.min(1, confirmedAmount / requiredAmount) : 1;
  const scheduleItems = (item.repaymentSchedule || []).map((entry) => {
    const amountPaid = Number(entry.amountPaid || 0);
    const totalDue = Number(entry.totalDue || 0);
    const normalizedStatus = normalizeRepaymentStatus(entry.status, entry.dueDate);
    return {
      ...entry,
      principalAmount: Number(entry.principalAmount || 0),
      interestAmount: Number(entry.interestAmount || 0),
      feeAmount: Number(entry.feeAmount || 0),
      totalDue,
      amountPaid,
      outstandingAmount: roundMoney(Math.max(totalDue - amountPaid, 0)),
      status: normalizedStatus,
    };
  });
  const totalScheduled = roundMoney(scheduleItems.reduce((sum, entry) => sum + entry.totalDue, 0));
  const totalPaid = roundMoney(scheduleItems.reduce((sum, entry) => sum + entry.amountPaid, 0));
  const outstandingBalance = roundMoney(scheduleItems.reduce((sum, entry) => sum + entry.outstandingAmount, 0));
  const nextDueInstallment = scheduleItems.find((entry) => ["PENDING", "PARTIAL", "OVERDUE"].includes(entry.status)) || null;

  return {
    id: item.id,
    status: item.status,
    amountRequested: Number(item.amountRequested || 0),
    termMonths: item.termMonths,
    purpose: item.purpose,
    employmentStatus: item.employmentStatus,
    employerName: item.employerName,
    businessName: item.businessName,
    monthlyIncomeSnapshot: item.monthlyIncomeSnapshot == null ? null : Number(item.monthlyIncomeSnapshot),
    monthlyExpenseSnapshot: item.monthlyExpenseSnapshot == null ? null : Number(item.monthlyExpenseSnapshot),
    applicantNote: item.applicantNote,
    reviewNote: item.reviewNote,
    approvedAmount: item.approvedAmount == null ? null : Number(item.approvedAmount),
    approvedTermMonths: item.approvedTermMonths ?? null,
    annualInterestRatePct,
    processingFeePct,
    disbursedAmount: item.disbursedAmount == null ? null : Number(item.disbursedAmount),
    disbursementRef: item.disbursementRef || null,
    disbursedAt: item.disbursedAt || null,
    repaymentStartDate: item.repaymentStartDate || null,
    reviewedAt: item.reviewedAt,
    submittedAt: item.submittedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    product: {
      ...item.product,
      annualInterestRatePct: Number(item.product?.annualInterestRatePct || 0),
      processingFeePct: Number(item.product?.processingFeePct || 0),
      equityRequirementPct: requirementPct,
      minimumEquityAmount,
      requiredDocuments: normalizeRequiredDocuments(item.product?.requiredDocuments),
    },
    documents: (item.documents || []).map((doc) => ({
      ...doc,
      sizeBytes: Number(doc.sizeBytes || 0),
    })),
    equity: {
      requiredAmount,
      confirmedAmount,
      pendingAmount,
      remainingAmount,
      progressPct,
      canApprove: remainingAmount <= 0,
    },
    equityContributions: (item.equityContributions || []).map((entry) => ({
      ...entry,
      amount: Number(entry.amount || 0),
    })),
    equityPayments: (item.equityPayments || []).map((entry) => ({
      ...entry,
      amount: Number(entry.amount || 0),
    })),
    repaymentPayments: (item.repaymentPayments || []).map((entry) => ({
      ...entry,
      amount: Number(entry.amount || 0),
    })),
    updates: (item.updates || []).map((entry) => ({
      ...entry,
      note: entry.note || null,
      metadata: entry.metadata || null,
    })),
    repaymentSummary: {
      installmentsCount: scheduleItems.length,
      totalScheduled,
      totalPaid,
      outstandingBalance,
      nextDueDate: nextDueInstallment?.dueDate || null,
      nextDueAmount: nextDueInstallment?.outstandingAmount || null,
      overdueCount: scheduleItems.filter((entry) => entry.status === "OVERDUE").length,
    },
    repaymentSchedule: scheduleItems,
    transactions: (item.transactions || []).map((entry) => ({
      ...entry,
      amount: Number(entry.amount || 0),
    })),
    reviewedBy: item.reviewedBy || null,
    disbursedBy: item.disbursedBy || null,
    user: item.user || null,
  };
}

module.exports = {
  DEFAULT_LOAN_PRODUCTS,
  loanApplicationInclude,
  adminLoanApplicationInclude,
  addLoanApplicationUpdate,
  buildRepaymentSchedule,
  computeInstallmentStatus,
  ensureDefaultLoanProducts,
  normalizeRequiredDocuments,
  roundMoney,
  serializeLoanApplication,
};
