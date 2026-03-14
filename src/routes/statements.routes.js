const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user");
const {
  getMyContributionsStatement,
  getMyInvestmentStatement,
  getMyLoanStatement,
  getMyFundTransfersStatement,
} = require("../controllers/statements.controller");

router.get("/mycontributions", requireAuth, requireUserRole, getMyContributionsStatement);
router.get("/myinvestment", requireAuth, requireUserRole, getMyInvestmentStatement);
router.get("/myloans", requireAuth, requireUserRole, getMyLoanStatement);
router.get("/myfundtransfers", requireAuth, requireUserRole, getMyFundTransfersStatement);

module.exports = router;
