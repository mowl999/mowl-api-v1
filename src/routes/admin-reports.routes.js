const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { getAdminContributionSplitReport } = require("../controllers/reports.controller");

router.get("/contribution-split", requireAuth, requireAdmin, getAdminContributionSplitReport);

module.exports = router;

