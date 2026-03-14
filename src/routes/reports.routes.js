const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireUserRole } = require("../middleware/user");
const { getMyContributionsReport } = require("../controllers/reports.controller");

router.get("/mycontributions", requireAuth, requireUserRole, getMyContributionsReport);

module.exports = router;

