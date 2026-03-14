const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user");
const {
  createFundTransferTransaction,
  listFundTransferTransactions,
} = require("../controllers/fund-transfers.controller");

router.get("/transactions", requireAuth, requireUserRole, listFundTransferTransactions);
router.post("/transactions", requireAuth, requireUserRole, createFundTransferTransaction);

module.exports = router;

