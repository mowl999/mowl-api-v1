const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { getCurrentRuleConfig, updateCurrentRuleConfig } = require("../controllers/admin-config.controller");

router.get("/rules/current", requireAuth, requireAdmin, getCurrentRuleConfig);
router.patch("/rules/current", requireAuth, requireAdmin, updateCurrentRuleConfig);

module.exports = router;
