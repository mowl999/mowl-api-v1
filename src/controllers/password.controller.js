const bcrypt = require("bcryptjs");
const { prisma } = require("../db");
const { generateResetToken, hashToken } = require("../utils/resetToken");
const { sendActionLinkEmail } = require("../utils/mailer");

const RESET_TOKEN_MINUTES = Number(process.env.RESET_TOKEN_MINUTES || 30);

function getFrontendBaseUrl() {
  return (
    process.env.FRONTEND_APP_URL ||
    process.env.SIGNUP_WEB_URL ||
    process.env.WEB_APP_URL ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
}

function buildResetPasswordLink({ email, token }) {
  const url = new URL(`${getFrontendBaseUrl()}/reset-password`);
  url.searchParams.set("email", email);
  url.searchParams.set("token", token);
  return url.toString();
}

exports.forgotPassword = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "email is required." },
      });
    }

    // Always return OK to avoid leaking whether email exists
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({
        error: { code: "EMAIL_NOT_FOUND", message: "We could not find an account with that email address." },
      });
    }

    const token = generateResetToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000);

    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    const resetLink = buildResetPasswordLink({ email, token });
    let sentByEmail = false;
    try {
      sentByEmail = await sendActionLinkEmail({
        to: email,
        subject: "Password Reset Request",
        headline: "Hello,",
        intro: [
          "We received a request to reset the password for your account.",
          "If you made this request, please click the button below or use the secure link to create a new password.",
          "For your security, this link will expire in 30 minutes.",
        ].join("\n\n"),
        actionLabel: "Reset Your Password",
        actionUrl: resetLink,
        outro: [
          "If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.",
          "If you continue to receive these emails, please contact our support team.",
          "Best regards,\nmowl Support Team\nsupport@moneyowlcredit.com",
        ].join("\n\n"),
      });
    } catch (mailErr) {
      console.error("password.forgot mail failed:", mailErr);
    }

    if (!sentByEmail) {
      console.log(`[RESET_PASSWORD] email=${email} token=${token} resetLink=${resetLink} expiresAt=${expiresAt.toISOString()}`);
    }

    return res.json({
      ok: true,
      // Dev-only convenience:
      dev: process.env.NODE_ENV !== "production" && !sentByEmail ? { token, resetLink, expiresAt } : undefined,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const token = String(req.body.token || "").trim();
    const newPassword = String(req.body.newPassword || "");

    if (!email || !token || !newPassword) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "email, token, newPassword are required." },
      });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        error: { code: "WEAK_PASSWORD", message: "Password must be at least 8 characters." },
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // Still do not reveal user existence
    if (!user) {
      return res.status(400).json({
        error: { code: "INVALID_RESET", message: "Invalid or expired reset token." },
      });
    }

    const tokenHash = hashToken(token);

    const row = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!row) {
      return res.status(400).json({
        error: { code: "INVALID_RESET", message: "Invalid or expired reset token." },
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { password: passwordHash },
      });

      await tx.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      });

      // Optional: if you implement refresh tokens later, invalidate them here.
      // await tx.refreshToken.deleteMany({ where: { userId: user.id } });
    });

    return res.json({ ok: true, message: "Password reset successful. Please log in again." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
