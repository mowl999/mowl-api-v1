const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { markPayoutSent } = require("../controllers/payouts.controller");

router.patch("/:payoutId/mark-sent", requireAuth, markPayoutSent);

module.exports = router;
