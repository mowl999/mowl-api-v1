const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { getUserProducts, setUserProducts } = require("../controllers/access.controller");

const router = express.Router();

router.get("/users/:userId/products", requireAuth, requireAdmin, getUserProducts);
router.put("/users/:userId/products", requireAuth, requireAdmin, setUserProducts);

module.exports = router;

