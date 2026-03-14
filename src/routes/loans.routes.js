const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user");
const { createLoanTransaction, listLoanTransactions } = require("../controllers/loans.controller");

router.get("/transactions", requireAuth, requireUserRole, listLoanTransactions);
router.post("/transactions", requireAuth, requireUserRole, createLoanTransaction);

module.exports = router;

