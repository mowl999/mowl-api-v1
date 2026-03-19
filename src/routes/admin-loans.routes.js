const express = require("express");

const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const {
  listAdminLoanApplications,
  getAdminLoanDashboard,
  getAdminLoanSettings,
  updateAdminLoanSettings,
  runAdminLoanReminderJob,
  reviewLoanApplication,
  disburseLoanApplication,
  listAdminLoanProducts,
  createAdminLoanProduct,
  updateAdminLoanProduct,
  listAdminLoanEquityPayments,
  reviewAdminLoanEquityPayment,
  listAdminLoanRepaymentPayments,
  reviewAdminLoanRepaymentPayment,
} = require("../controllers/admin-loans.controller");

router.get("/applications", requireAuth, requireAdmin, listAdminLoanApplications);
router.get("/dashboard", requireAuth, requireAdmin, getAdminLoanDashboard);
router.get("/settings", requireAuth, requireAdmin, getAdminLoanSettings);
router.patch("/settings", requireAuth, requireAdmin, updateAdminLoanSettings);
router.post("/reminders/run", requireAuth, requireAdmin, runAdminLoanReminderJob);
router.patch("/applications/:applicationId/review", requireAuth, requireAdmin, reviewLoanApplication);
router.post("/applications/:applicationId/disburse", requireAuth, requireAdmin, disburseLoanApplication);
router.get("/products", requireAuth, requireAdmin, listAdminLoanProducts);
router.post("/products", requireAuth, requireAdmin, createAdminLoanProduct);
router.patch("/products/:productId", requireAuth, requireAdmin, updateAdminLoanProduct);
router.get("/equity-payments", requireAuth, requireAdmin, listAdminLoanEquityPayments);
router.patch("/equity-payments/:paymentId/review", requireAuth, requireAdmin, reviewAdminLoanEquityPayment);
router.get("/repayment-payments", requireAuth, requireAdmin, listAdminLoanRepaymentPayments);
router.patch("/repayment-payments/:paymentId/review", requireAuth, requireAdmin, reviewAdminLoanRepaymentPayment);

module.exports = router;
