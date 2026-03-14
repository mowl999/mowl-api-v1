let nodemailer = null;
try {
  // Optional dependency in this environment; fallback to console OTP when unavailable.
  // eslint-disable-next-line global-require
  nodemailer = require("nodemailer");
} catch (_) {
  nodemailer = null;
}

function hasResendConfig() {
  return !!process.env.RESEND_API_KEY && !!getMailFrom();
}

function hasSmtpConfig() {
  return (
    !!process.env.SMTP_HOST &&
    !!process.env.SMTP_PORT &&
    !!process.env.SMTP_USER &&
    !!process.env.SMTP_PASS &&
    !!process.env.SMTP_FROM
  );
}

function getMailFrom() {
  return process.env.EMAIL_FROM || process.env.RESEND_FROM || process.env.SMTP_FROM || "";
}

function renderTextBlockHtml(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => {
      const html = paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("<br />");
      return `<p style="margin:0 0 12px;line-height:1.6;color:#334155;">${html}</p>`;
    })
    .join("");
}

async function sendViaResend({ to, subject, html, text }) {
  if (!hasResendConfig()) return false;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: getMailFrom(),
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${body || "Unknown error"}`);
  }

  return true;
}

async function sendViaSmtp({ to, subject, html, text }) {
  if (!hasSmtpConfig() || !nodemailer) return false;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: getMailFrom(),
    to,
    subject,
    text,
    html,
  });

  return true;
}

async function sendEmail(payload) {
  try {
    if (await sendViaResend(payload)) return true;
  } catch (err) {
    console.error("mailer.resend failed:", err);
  }

  try {
    if (await sendViaSmtp(payload)) return true;
  } catch (err) {
    console.error("mailer.smtp failed:", err);
  }

  return false;
}

async function sendOtpEmail({ to, otp, purpose = "Email Verification" }) {
  return sendEmail({
    to,
    subject: `Your ${purpose} OTP code`,
    text: `Your OTP code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your OTP code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
  });
}

async function sendActionLinkEmail({ to, subject, headline, intro, actionLabel, actionUrl, outro }) {
  const safeUrl = String(actionUrl || "");

  return sendEmail({
    to,
    subject,
    text: `${headline}\n\n${intro}\n\n${actionLabel}: ${safeUrl}\n\n${outro || ""}`.trim(),
    html: [
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;background:#f8fafc;padding:24px;">`,
      `<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;">`,
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#0f172a;">${headline}</p>`,
      renderTextBlockHtml(intro),
      `<p style="margin:20px 0 16px;"><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#4338ca;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${actionLabel}</a></p>`,
      `<p style="margin:0 0 8px;line-height:1.6;color:#334155;">If the button above does not work, copy and paste the link below into your browser:</p>`,
      `<p style="margin:0 0 16px;line-height:1.6;word-break:break-all;"><a href="${safeUrl}" style="color:#4338ca;text-decoration:underline;">${safeUrl}</a></p>`,
      renderTextBlockHtml(outro),
      `</div>`,
      `</div>`,
    ].join(""),
  });
}

module.exports = {
  sendOtpEmail,
  sendActionLinkEmail,
  hasResendConfig,
  hasSmtpConfig,
};
