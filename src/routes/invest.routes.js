const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user");
const { listProducts, createPlan, listPlans, getInvestDashboard, getInvestReports } = require("../controllers/invest.controller");

router.get("/products", requireAuth, requireUserRole, listProducts);
router.post("/plans", requireAuth, requireUserRole, createPlan);
router.get("/plans", requireAuth, requireUserRole, listPlans);
router.get("/dashboard", requireAuth, requireUserRole, getInvestDashboard);
router.get("/reports", requireAuth, requireUserRole, getInvestReports);

module.exports = router;
