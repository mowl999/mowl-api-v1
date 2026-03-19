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

function getSupportEmail() {
  return process.env.SUPPORT_EMAIL || "support@moneyowlcredit.com";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMoney(amount, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amount || 0));
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

async function sendLoanReminderEmail({
  to,
  reminderType,
  borrowerName,
  productName,
  installmentNumber,
  dueDate,
  outstandingAmount,
  currency = "GBP",
  daysLate = 0,
  actionUrl,
}) {
  const safeUrl = String(actionUrl || "");
  const supportEmail = getSupportEmail();
  const formattedDueDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(dueDate));
  const formattedOutstanding = formatMoney(outstandingAmount, currency);
  const displayName = String(borrowerName || "").trim() || "there";
  const isOverdue = reminderType === "LOAN_REPAYMENT_OVERDUE";

  const subject = isOverdue ? "Action needed: overdue MyLoan repayment" : "Upcoming MyLoan repayment due";
  const eyebrow = isOverdue ? "MyLoan overdue reminder" : "MyLoan upcoming repayment reminder";
  const headline = isOverdue ? "Your repayment needs attention" : "Your next repayment is coming up";
  const accent = isOverdue ? "#dc2626" : "#4338ca";
  const toneBg = isOverdue ? "#fef2f2" : "#eef2ff";
  const toneBorder = isOverdue ? "#fecaca" : "#c7d2fe";

  const summaryLines = isOverdue
    ? [
        `Hello ${displayName},`,
        `Installment ${installmentNumber} for ${productName} became overdue on ${formattedDueDate}.`,
        `Outstanding amount: ${formattedOutstanding}.`,
        `${daysLate} day${daysLate === 1 ? "" : "s"} late. Please make payment as soon as possible to bring your facility back on schedule.`,
      ]
    : [
        `Hello ${displayName},`,
        `Installment ${installmentNumber} for ${productName} is due on ${formattedDueDate}.`,
        `Amount due: ${formattedOutstanding}.`,
        "Please complete payment before the due date to keep your repayment schedule current.",
      ];

  const text = [
    eyebrow,
    "",
    ...summaryLines,
    "",
    `Open MyLoan Repayments: ${safeUrl}`,
    "",
    "If you have already made a manual bank transfer, you can ignore this reminder while admin confirmation is pending.",
    "",
    "Best regards,",
    "mowl Support Team",
    supportEmail,
  ].join("\n");

  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;background:#f8fafc;padding:24px;">`,
    `<div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;padding:32px;">`,
    `<div style="display:inline-block;margin-bottom:16px;padding:6px 10px;border-radius:999px;background:${toneBg};border:1px solid ${toneBorder};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${accent};">${escapeHtml(eyebrow)}</div>`,
    `<h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#0f172a;">${escapeHtml(headline)}</h1>`,
    renderTextBlockHtml(summaryLines.join("\n\n")),
    `<div style="margin:20px 0 22px;border:1px solid ${toneBorder};background:${toneBg};border-radius:14px;padding:16px 18px;">`,
    `<div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:${accent};font-weight:700;">Repayment summary</div>`,
    `<div style="margin-top:10px;font-size:14px;color:#334155;line-height:1.7;">`,
    `<div><strong>Product:</strong> ${escapeHtml(productName)}</div>`,
    `<div><strong>Installment:</strong> ${escapeHtml(installmentNumber)}</div>`,
    `<div><strong>Due date:</strong> ${escapeHtml(formattedDueDate)}</div>`,
    `<div><strong>${isOverdue ? "Outstanding" : "Amount due"}:</strong> ${escapeHtml(formattedOutstanding)}</div>`,
    isOverdue ? `<div><strong>Days late:</strong> ${escapeHtml(daysLate)}</div>` : "",
    `</div>`,
    `</div>`,
    `<p style="margin:0 0 18px;"><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:${accent};color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;">Open MyLoan Repayments</a></p>`,
    `<p style="margin:0 0 8px;line-height:1.6;color:#334155;">If the button above does not work, copy and paste the link below into your browser:</p>`,
    `<p style="margin:0 0 16px;line-height:1.6;word-break:break-all;"><a href="${safeUrl}" style="color:${accent};text-decoration:underline;">${escapeHtml(safeUrl)}</a></p>`,
    `<p style="margin:0 0 16px;line-height:1.6;color:#334155;">If you have already made a manual bank transfer, you can ignore this reminder while admin confirmation is pending.</p>`,
    `<p style="margin:0;line-height:1.6;color:#334155;">Best regards,<br />mowl Support Team<br /><a href="mailto:${escapeHtml(supportEmail)}" style="color:${accent};text-decoration:none;">${escapeHtml(supportEmail)}</a></p>`,
    `</div>`,
    `</div>`,
  ].join("");

  return sendEmail({ to, subject, text, html });
}

module.exports = {
  sendOtpEmail,
  sendActionLinkEmail,
  sendLoanReminderEmail,
  hasResendConfig,
  hasSmtpConfig,
};
