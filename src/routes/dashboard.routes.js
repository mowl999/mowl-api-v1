const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

const { getUserDashboard, getTrustHistory, getAdminDashboard } = require("../controllers/dashboard.controller");

router.get("/user", requireAuth, getUserDashboard);
router.get("/trust-history", requireAuth, getTrustHistory);
router.get("/admin", requireAuth, requireAdmin, getAdminDashboard);

module.exports = router;
