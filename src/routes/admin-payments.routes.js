const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { listPayments, reviewPayment } = require("../controllers/admin-payments.controller");

router.get("/", requireAuth, requireAdmin, listPayments);
router.patch("/:paymentId/review", requireAuth, requireAdmin, reviewPayment);

module.exports = router;

