require("dotenv").config();
const express = require("express");
const cors = require("cors");
const PORT = Number(process.env.PORT) || 3000;

const authRoutes = require("./routes/auth.routes");
const depositsRoutes = require("./routes/deposits.routes");
const eligibilityRoutes = require("./routes/eligibility.routes");
const plansRoutes = require("./routes/plans.routes");
const payoutsRoutes = require("./routes/payouts.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const accessRoutes = require("./routes/access.routes");
const adminUsersRoutes = require("./routes/admin-users.routes");
const adminPaymentsRoutes = require("./routes/admin-payments.routes");
const adminReportsRoutes = require("./routes/admin-reports.routes");
const reportsRoutes = require("./routes/reports.routes");
const adminSwapsRoutes = require("./routes/admin-swaps.routes");
const adminConfigRoutes = require("./routes/admin-config.routes");
const adminPausesRoutes = require("./routes/admin-pauses.routes");
const investRoutes = require("./routes/invest.routes");
const adminInvestRoutes = require("./routes/admin-invest.routes");
const statementsRoutes = require("./routes/statements.routes");
const loansRoutes = require("./routes/loans.routes");
const fundTransfersRoutes = require("./routes/fund-transfers.routes");
const app = express();
app.set("trust proxy", 1);

function getAllowedOrigins() {
  const explicitOrigins = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const fallbackOrigins = [
    process.env.FRONTEND_APP_URL,
    process.env.SIGNUP_WEB_URL,
    process.env.WEB_APP_URL,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].filter(Boolean);

  return [...new Set([...explicitOrigins, ...fallbackOrigins])];
}

const allowedOrigins = getAllowedOrigins();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

// Routes
app.use("/v1/auth", authRoutes);
app.use("/v1/deposits", depositsRoutes);
app.use("/v1/eligibility", eligibilityRoutes);
app.use("/v1/plans", plansRoutes);
app.use("/v1/payouts", payoutsRoutes);
app.use("/v1/dashboard", dashboardRoutes);
app.use("/v1/invest", investRoutes);
app.use("/v1/loans", loansRoutes);
app.use("/v1/fund-transfers", fundTransfersRoutes);
app.use("/v1/reports", reportsRoutes);
app.use("/v1/admin/access", accessRoutes);
app.use("/v1/admin/users", adminUsersRoutes);
app.use("/v1/admin/payments", adminPaymentsRoutes);
app.use("/v1/admin/swaps", adminSwapsRoutes);
app.use("/v1/admin/reports", adminReportsRoutes);
app.use("/v1/admin/config", adminConfigRoutes);
app.use("/v1/admin/pauses", adminPausesRoutes);
app.use("/v1/admin/invest", adminInvestRoutes);
app.use("/v1/statements", statementsRoutes);




app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
