const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user"); // ✅ add

const { createPlan, getPlanMembers, listPlans } = require("../controllers/plans.controller");
const { swapQuote, requestSwap, executeSwap, listMySwaps } = require("../controllers/swaps.controller");
const { createContribution, listContributions, confirmContribution } = require("../controllers/contributions.controller");
const {
  submitGatewayPayment,
  submitManualTransfer,
  listContributionPayments,
} = require("../controllers/contribution-payments.controller");
const { closeCycle, listPayouts } = require("../controllers/cycles.controller");
const { getPlanSummary } = require("../controllers/summary.controller");
const { getPlanPaymentOptions } = require("../controllers/payment-options.controller");
const { getPauseOptions, requestPause, listPauses } = require("../controllers/plan-pauses.controller");

// Plans (USER only)
router.post("/", requireAuth, requireUserRole, createPlan);
router.get("/", requireAuth, requireUserRole, listPlans);
router.get("/:planId/members", requireAuth, requireUserRole, getPlanMembers);
router.get("/:planId/summary", requireAuth, requireUserRole, getPlanSummary);
router.get("/:planId/payment-options", requireAuth, requireUserRole, getPlanPaymentOptions);
router.get("/:planId/pauses/options", requireAuth, requireUserRole, getPauseOptions);
router.get("/:planId/pauses", requireAuth, requireUserRole, listPauses);
router.post("/:planId/pauses/request", requireAuth, requireUserRole, requestPause);

// Swaps (USER only)
router.post("/:planId/swaps/quote", requireAuth, requireUserRole, swapQuote);
router.post("/:planId/swaps/request", requireAuth, requireUserRole, requestSwap);
router.get("/:planId/swaps", requireAuth, requireUserRole, listMySwaps);
router.post("/:planId/swaps/execute", requireAuth, requireUserRole, executeSwap);

// Contributions (USER only)
router.post("/:planId/contributions", requireAuth, requireUserRole, createContribution);
router.get("/:planId/contributions", requireAuth, requireUserRole, listContributions);
router.patch(
  "/:planId/contributions/:contributionId/confirm",
  requireAuth,
  requireUserRole,
  confirmContribution
);
router.post("/:planId/contributions/:contributionId/payments/gateway", requireAuth, requireUserRole, submitGatewayPayment);
router.post("/:planId/contributions/:contributionId/payments/manual", requireAuth, requireUserRole, submitManualTransfer);
router.get("/:planId/contributions/:contributionId/payments", requireAuth, requireUserRole, listContributionPayments);

// Cycles + payouts (USER only)
router.post("/:planId/cycles/close", requireAuth, requireUserRole, closeCycle);
router.get("/:planId/payouts", requireAuth, requireUserRole, listPayouts);

module.exports = router;
