const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user"); // ✅ add
const { initialDeposit } = require("../controllers/deposits.controller");

// POST /v1/deposits/initial
router.post("/initial", requireAuth, requireUserRole, initialDeposit);

module.exports = router;