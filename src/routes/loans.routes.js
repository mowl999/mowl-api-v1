const express = require("express");
const multer = require("multer");

const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user");
const {
  listLoanProducts,
  listMyLoanApplications,
  getMyLoanApplication,
  getLoanEquityPaymentOptions,
  getLoanRepaymentPaymentOptions,
  listLoanEquityPayments,
  listMyLoanReminders,
  listDismissedLoanReminders,
  markLoanReminderRead,
  markLoanReminderUnread,
  dismissLoanReminder,
  restoreLoanReminder,
  markAllLoanRemindersRead,
  createLoanApplicationDraft,
  updateLoanApplication,
  submitLoanApplication,
  respondToLoanInfoRequest,
  submitLoanEquityGatewayPayment,
  submitLoanEquityManualPayment,
  submitLoanRepaymentGatewayPayment,
  submitLoanRepaymentManualPayment,
  uploadLoanApplicationDocument,
  deleteLoanApplicationDocument,
  downloadLoanApplicationDocument,
  createLoanTransaction,
  listLoanTransactions,
} = require("../controllers/loans.controller");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

router.get("/products", requireAuth, requireUserRole, listLoanProducts);
router.get("/applications", requireAuth, requireUserRole, listMyLoanApplications);
router.get("/applications/:applicationId", requireAuth, requireUserRole, getMyLoanApplication);
router.get("/reminders", requireAuth, requireUserRole, listMyLoanReminders);
router.get("/reminders/history", requireAuth, requireUserRole, listDismissedLoanReminders);
router.post("/reminders/read-all", requireAuth, requireUserRole, markAllLoanRemindersRead);
router.post("/reminders/:notificationId/read", requireAuth, requireUserRole, markLoanReminderRead);
router.post("/reminders/:notificationId/unread", requireAuth, requireUserRole, markLoanReminderUnread);
router.post("/reminders/:notificationId/dismiss", requireAuth, requireUserRole, dismissLoanReminder);
router.post("/reminders/:notificationId/restore", requireAuth, requireUserRole, restoreLoanReminder);
router.get("/applications/:applicationId/equity/payment-options", requireAuth, requireUserRole, getLoanEquityPaymentOptions);
router.get("/applications/:applicationId/equity/payments", requireAuth, requireUserRole, listLoanEquityPayments);
router.get("/installments/:installmentId/payment-options", requireAuth, requireUserRole, getLoanRepaymentPaymentOptions);
router.post("/applications", requireAuth, requireUserRole, createLoanApplicationDraft);
router.patch("/applications/:applicationId", requireAuth, requireUserRole, updateLoanApplication);
router.post("/applications/:applicationId/submit", requireAuth, requireUserRole, submitLoanApplication);
router.post("/applications/:applicationId/respond", requireAuth, requireUserRole, respondToLoanInfoRequest);
router.post("/applications/:applicationId/equity/payments/gateway", requireAuth, requireUserRole, submitLoanEquityGatewayPayment);
router.post("/applications/:applicationId/equity/payments/manual", requireAuth, requireUserRole, submitLoanEquityManualPayment);
router.post("/installments/:installmentId/payments/gateway", requireAuth, requireUserRole, submitLoanRepaymentGatewayPayment);
router.post("/installments/:installmentId/payments/manual", requireAuth, requireUserRole, submitLoanRepaymentManualPayment);
router.post(
  "/applications/:applicationId/documents",
  requireAuth,
  requireUserRole,
  upload.single("file"),
  uploadLoanApplicationDocument
);
router.delete(
  "/applications/:applicationId/documents/:documentId",
  requireAuth,
  requireUserRole,
  deleteLoanApplicationDocument
);
router.get(
  "/applications/:applicationId/documents/:documentId/download",
  requireAuth,
  downloadLoanApplicationDocument
);

router.get("/transactions", requireAuth, requireUserRole, listLoanTransactions);
router.post("/transactions", requireAuth, requireUserRole, createLoanTransaction);

module.exports = router;
