const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { listPauses, reviewPause } = require("../controllers/admin-pauses.controller");

router.get("/", requireAuth, requireAdmin, listPauses);
router.patch("/:pauseId/review", requireAuth, requireAdmin, reviewPause);

module.exports = router;
