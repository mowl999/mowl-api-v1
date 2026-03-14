const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const {
  adminListProducts,
  adminCreateProduct,
  adminUpdateProduct,
  adminListUserRates,
  adminUpsertUserRate,
} = require("../controllers/invest.controller");

router.get("/products", requireAuth, requireAdmin, adminListProducts);
router.post("/products", requireAuth, requireAdmin, adminCreateProduct);
router.patch("/products/:productId", requireAuth, requireAdmin, adminUpdateProduct);
router.get("/user-rates", requireAuth, requireAdmin, adminListUserRates);
router.put("/user-rates", requireAuth, requireAdmin, adminUpsertUserRate);

module.exports = router;
