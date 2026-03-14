function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(n) {
  return Number((Number(n) || 0).toFixed(2));
}

function normalizeRuleOptions(options = {}) {
  return {
    earlyChargePct: Number.isFinite(Number(options.earlyChargePct))
      ? Math.abs(Number(options.earlyChargePct))
      : 0.1,
    lateCompensationPct: Number.isFinite(Number(options.lateCompensationPct))
      ? Math.abs(Number(options.lateCompensationPct))
      : 0.03,
  };
}

// Signed adjustment model:
// - position 1 => -10% (charge)
// - last position => +3% (compensation)
// negative means charge, positive means compensation.
function getPositionInterestRate(position, memberCount, options = {}) {
  const pos = Number(position || 0);
  const total = Number(memberCount || 0);
  if (!Number.isFinite(pos) || !Number.isFinite(total) || total <= 1 || pos < 1 || pos > total) return 0;

  const { earlyChargePct, lateCompensationPct } = normalizeRuleOptions(options);
  const start = -Math.abs(earlyChargePct);
  const end = Math.abs(lateCompensationPct);
  const progress = (pos - 1) / (total - 1);
  const rate = start + (end - start) * progress;
  return Number(clamp(rate, -0.5, 0.5).toFixed(4));
}

// Contribution side:
// negative adjustment means user pays more, positive means user pays less.
function applyPositionInterest(baseAmount, interestRate) {
  const base = Number(baseAmount || 0);
  const rate = Number(interestRate || 0);
  const adjusted = base * (1 - rate);
  return round2(Math.max(0, adjusted));
}

// Payout side:
// negative adjustment means user receives less, positive means user receives more.
function applyPayoutPositionInterest(baseAmount, interestRate) {
  const base = Number(baseAmount || 0);
  const rate = Number(interestRate || 0);
  const adjusted = base * (1 + rate);
  return round2(Math.max(0, adjusted));
}

module.exports = {
  getPositionInterestRate,
  applyPositionInterest,
  applyPayoutPositionInterest,
  normalizeRuleOptions,
};
