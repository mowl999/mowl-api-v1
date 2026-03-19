const express = require("express");
const {
  signup,
  completeSignup,
  getSignupLinkStatus,
  verifyEmailOtp,
  resendEmailOtp,
  updateFinancialProfile,
  updateProfile,
  changePassword,
  login,
  me,
} = require("../controllers/auth.controller");
const { forgotPassword, resetPassword } = require("../controllers/password.controller");
const { requireAuth } = require("../middleware/auth"); // adjust if your path differs

const router = express.Router();

router.post("/signup", signup);
router.post("/register", signup); // backward-compatible alias
router.get("/signup/link-status", getSignupLinkStatus);
router.post("/signup/complete", completeSignup);
router.post("/verify-email-otp", verifyEmailOtp);
router.post("/resend-email-otp", resendEmailOtp);
router.post("/resend-signup-link", resendEmailOtp);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// ✅ Pattern 1: user profile + entitlements
router.get("/me", requireAuth, me);
router.patch("/financial-profile", requireAuth, updateFinancialProfile);
router.patch("/profile", requireAuth, updateProfile);
router.post("/change-password", requireAuth, changePassword);

module.exports = router;
