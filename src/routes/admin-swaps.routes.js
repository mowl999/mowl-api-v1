const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { listSwaps, reviewSwap, getSwapLedger } = require("../controllers/admin-swaps.controller");

router.get("/", requireAuth, requireAdmin, listSwaps);
router.get("/ledger", requireAuth, requireAdmin, getSwapLedger);
router.patch("/:swapId/review", requireAuth, requireAdmin, reviewSwap);

module.exports = router;
