const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { listUsers, createUser, updateUser } = require("../controllers/admin-users.controller");

const router = express.Router();

router.get("/", requireAuth, requireAdmin, listUsers);
router.post("/", requireAuth, requireAdmin, createUser);
router.patch("/:userId", requireAuth, requireAdmin, updateUser);

module.exports = router;
