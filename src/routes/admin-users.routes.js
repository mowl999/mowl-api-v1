const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { listUsers, createUser, updateUser, resetUserPassword } = require("../controllers/admin-users.controller");

const router = express.Router();

router.get("/", requireAuth, requireAdmin, listUsers);
router.post("/", requireAuth, requireAdmin, createUser);
router.patch("/:userId", requireAuth, requireAdmin, updateUser);
router.post("/:userId/reset-password", requireAuth, requireAdmin, resetUserPassword);

module.exports = router;
