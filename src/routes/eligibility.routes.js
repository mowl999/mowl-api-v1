const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user"); // ✅ add
const { getEligibility } = require("../controllers/eligibility.controller");

// GET /v1/eligibility
router.get("/", requireAuth, requireUserRole, getEligibility);

module.exports = router;