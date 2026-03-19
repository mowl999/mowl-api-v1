// src/controllers/auth.controller.js
const bcrypt = require("bcrypt");
const { z } = require("zod");
const { prisma } = require("../db");
const { signToken } = require("../utils/jwt");
const { generateOtpCode, hashOtp } = require("../utils/otp");
const { generateResetToken, hashToken } = require("../utils/resetToken");
const { sendOtpEmail, sendActionLinkEmail } = require("../utils/mailer");
const { getUserTrustProfile } = require("../services/trust-score.service");

// Validation
const signupStartSchema = z.object({
  email: z.string().email(),
  products: z.array(z.enum(["THRIFT", "INVEST", "LOANS", "FUND_TRANSFERS"])).optional().default([]),
});

const completeSignupSchema = z.object({
  email: z.string().email(),
  token: z.string().min(20),
  firstName: z.string().trim().min(2),
  lastName: z.string().trim().min(2),
  password: z.string().min(8),
  products: z.array(z.enum(["THRIFT", "INVEST", "LOANS", "FUND_TRANSFERS"])).min(1),
  monthlyIncome: z.number().positive(),
  monthlyExpenses: z.number().nonnegative(),
  otherMonthlyEarnings: z.number().nonnegative().optional().default(0),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const updateProfileSchema = z.object({
  firstName: z.string().trim().min(2),
  lastName: z.string().trim().min(2),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10),
});

function safeUser(user) {
  return {
    id: user.id,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    fullName: user.fullName,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt || null,
    monthlyIncome: user.monthlyIncome ?? null,
    monthlyExpenses: user.monthlyExpenses ?? null,
    otherMonthlyEarnings: user.otherMonthlyEarnings ?? 0,
    state: user.state,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function defaultWorkspacesForRole(role) {
  return role === "ADMIN" ? ["ADMIN"] : [];
}

function buildFullName(firstName, lastName) {
  return `${String(firstName || "").trim()} ${String(lastName || "").trim()}`.trim();
}

function getSignupWebBaseUrl() {
  return (
    process.env.SIGNUP_WEB_URL ||
    process.env.FRONTEND_APP_URL ||
    process.env.WEB_APP_URL ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
}

function buildSignupLink({ email, token, products = [] }) {
  const url = new URL(`${getSignupWebBaseUrl()}/signup`);
  url.searchParams.set("mode", "complete");
  url.searchParams.set("email", email);
  url.searchParams.set("token", token);
  if (products.length > 0) url.searchParams.set("products", products.join(","));
  return url.toString();
}

function assertStrongSignupPassword(password, { firstName, lastName, email }) {
  const raw = String(password || "");
  const normalized = raw.toLowerCase();
  const emailLocal = String(email || "").split("@")[0].toLowerCase();
  const nameParts = [firstName, lastName, emailLocal]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => value.length >= 3);

  if (raw.length < 10) {
    return "Password must be at least 10 characters.";
  }
  if (!/[A-Za-z]/.test(raw) || !/\d/.test(raw)) {
    return "Password must include both letters and numbers.";
  }
  if (/\s/.test(raw)) {
    return "Password must not contain spaces.";
  }
  if (nameParts.some((part) => normalized.includes(part))) {
    return "Password must not contain your name or email.";
  }
  return null;
}

async function createEmailVerificationLink(tx, { userId, email, products }) {
  const token = generateResetToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  await tx.emailVerificationOtp.create({
    data: {
      userId,
      codeHash: tokenHash,
      expiresAt,
    },
  });

  return {
    token,
    expiresAt,
    verificationLink: buildSignupLink({ email, token, products }),
  };
}

async function assignDefaultWorkspaces(tx, user) {
  const workspaces = defaultWorkspacesForRole(user.role);
  if (workspaces.length === 0) return;

  await tx.userWorkspace.createMany({
    data: workspaces.map((workspace) => ({
      userId: user.id,
      workspace,
    })),
    skipDuplicates: true,
  });
}

async function signup(req, res) {
  const parsed = signupStartSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid signup email.",
        details: parsed.error.flatten(),
      },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const products = Array.from(new Set(parsed.data.products));

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && existing.emailVerifiedAt) {
    return res.status(409).json({
      error: { code: "EMAIL_EXISTS", message: "Email is already registered." },
    });
  }

  const placeholderPasswordHash = await bcrypt.hash(generateResetToken(), 12);

  try {
    const result = await prisma.$transaction(async (tx) => {
      let targetUser = existing;
      if (!targetUser) {
        targetUser = await tx.user.create({
          data: {
            fullName: email.split("@")[0],
            email,
            password: placeholderPasswordHash,
            state: "REGISTERED",
            role: "USER",
          },
        });
      } else {
        targetUser = await tx.user.update({
          where: { id: targetUser.id },
          data: {
            password: placeholderPasswordHash,
            role: "USER",
            state: "REGISTERED",
            emailVerifiedAt: null,
            monthlyIncome: null,
            monthlyExpenses: null,
            otherMonthlyEarnings: 0,
          },
        });
      }

      await tx.userWorkspace.deleteMany({ where: { userId: targetUser.id } });
      if (products.length > 0) {
        await tx.userWorkspace.createMany({
          data: products.map((workspace) => ({ userId: targetUser.id, workspace })),
          skipDuplicates: true,
        });
      }

      const verification = await createEmailVerificationLink(tx, {
        userId: targetUser.id,
        email,
        products,
      });

      return { user: targetUser, verification };
    });

    let sentByEmail = false;
    try {
      sentByEmail = await sendActionLinkEmail({
        to: email,
        subject: "Verify your email to continue your mowl signup",
        headline: "Complete your mowl signup",
        intro: "Confirm your email address to continue setting up your account.",
        actionLabel: "Verify email",
        actionUrl: result.verification.verificationLink,
        outro: "This link expires in 30 minutes.",
      });
    } catch (mailErr) {
      console.error("auth.signup mail failed:", mailErr);
    }

    if (!sentByEmail) {
      console.log(
        `[SIGNUP_LINK] email=${email} link=${result.verification.verificationLink} expiresAt=${result.verification.expiresAt.toISOString()} products=${products.join(",")}`
      );
    }

    return res.status(201).json({
      ok: true,
      verificationRequired: true,
      message: "Verification link sent. Check your email to continue signup.",
      user: safeUser(result.user),
      dev:
        process.env.NODE_ENV !== "production" && !sentByEmail
          ? {
              verificationLink: result.verification.verificationLink,
              expiresAt: result.verification.expiresAt,
            }
          : undefined,
    });
  } catch (e) {
    console.error("auth.signup failed:", e);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Signup failed." },
    });
  }
}

const signupLinkStatusSchema = z.object({
  email: z.string().email(),
  token: z.string().min(20),
});

async function getSignupLinkStatus(req, res) {
  const parsed = signupLinkStatusSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid signup link." },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const tokenHash = hashToken(parsed.data.token);
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      emailVerifiedAt: true,
      workspaces: { select: { workspace: true } },
    },
  });

  if (!user || user.emailVerifiedAt) {
    return res.status(400).json({
      error: { code: "INVALID_SIGNUP_LINK", message: "This signup link is invalid or already used." },
    });
  }

  const row = await prisma.emailVerificationOtp.findFirst({
    where: {
      userId: user.id,
      codeHash: tokenHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!row) {
    return res.status(400).json({
      error: { code: "INVALID_SIGNUP_LINK", message: "This signup link is invalid or expired." },
    });
  }

  return res.status(200).json({
    ok: true,
    email,
    products: (user.workspaces || [])
      .map((workspace) => workspace.workspace)
      .filter((workspace) => workspace !== "ADMIN"),
  });
}

async function completeSignup(req, res) {
  const parsed = completeSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid signup data.",
        details: parsed.error.flatten(),
      },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const token = parsed.data.token.trim();
  const firstName = parsed.data.firstName.trim();
  const lastName = parsed.data.lastName.trim();
  const password = parsed.data.password;
  const products = Array.from(new Set(parsed.data.products));
  const monthlyIncome = parsed.data.monthlyIncome;
  const monthlyExpenses = parsed.data.monthlyExpenses;
  const otherMonthlyEarnings = parsed.data.otherMonthlyEarnings || 0;
  const monthlyDisposable = monthlyIncome + otherMonthlyEarnings - monthlyExpenses;

  if (monthlyDisposable <= 0) {
    return res.status(400).json({
      error: {
        code: "INVALID_FINANCIAL_PROFILE",
        message: "Monthly disposable income must be greater than 0.",
      },
    });
  }

  const weakPasswordMessage = assertStrongSignupPassword(password, {
    firstName,
    lastName,
    email,
  });
  if (weakPasswordMessage) {
    return res.status(400).json({
      error: { code: "WEAK_PASSWORD", message: weakPasswordMessage },
    });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.emailVerifiedAt) {
    return res.status(400).json({
      error: { code: "INVALID_SIGNUP_LINK", message: "This signup session is invalid." },
    });
  }

  const row = await prisma.emailVerificationOtp.findFirst({
    where: {
      userId: user.id,
      codeHash: hashToken(token),
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!row) {
    return res.status(400).json({
      error: { code: "INVALID_SIGNUP_LINK", message: "This signup link is invalid or expired." },
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    await tx.emailVerificationOtp.update({
      where: { id: row.id },
      data: { usedAt: now },
    });

    await tx.userWorkspace.deleteMany({ where: { userId: user.id } });
    await tx.userWorkspace.createMany({
      data: products.map((workspace) => ({ userId: user.id, workspace })),
      skipDuplicates: true,
    });

    return tx.user.update({
      where: { id: user.id },
      data: {
        fullName: buildFullName(firstName, lastName),
        firstName,
        lastName,
        password: passwordHash,
        state: "ACTIVE",
        role: "USER",
        emailVerifiedAt: now,
        monthlyIncome,
        monthlyExpenses,
        otherMonthlyEarnings,
      },
    });
  });

  const authToken = signToken({
    userId: updated.id,
    email: updated.email,
    role: updated.role,
  });

  return res.status(200).json({
    ok: true,
    token: authToken,
    user: safeUser(updated),
  });
}

const verifyEmailOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/),
});

async function verifyEmailOtp(req, res) {
  const parsed = verifyEmailOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid verification data.",
        details: parsed.error.flatten(),
      },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const otp = parsed.data.otp;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(400).json({
      error: { code: "INVALID_OTP", message: "Invalid or expired OTP." },
    });
  }

  const now = new Date();
  const row = await prisma.emailVerificationOtp.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
      expiresAt: { gt: now },
      codeHash: hashOtp(otp),
    },
    orderBy: { createdAt: "desc" },
  });

  if (!row) {
    return res.status(400).json({
      error: { code: "INVALID_OTP", message: "Invalid or expired OTP." },
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.emailVerificationOtp.update({
      where: { id: row.id },
      data: { usedAt: now },
    });

    const nextUser = await tx.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: now,
        state: "ACTIVE",
      },
    });

    return nextUser;
  });

  const token = signToken({
    userId: updated.id,
    email: updated.email,
    role: updated.role,
  });

  return res.status(200).json({
    ok: true,
    token,
    user: safeUser(updated),
  });
}

const resendEmailOtpSchema = z.object({
  email: z.string().email(),
});

const financialProfileSchema = z.object({
  monthlyIncome: z.number().positive(),
  monthlyExpenses: z.number().nonnegative(),
  otherMonthlyEarnings: z.number().nonnegative().optional().default(0),
});

async function resendEmailOtp(req, res) {
  const parsed = resendEmailOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid resend request.",
        details: parsed.error.flatten(),
      },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, emailVerifiedAt: true, workspaces: { select: { workspace: true } } },
  });
  if (!user || user.emailVerifiedAt) {
    return res.status(200).json({ ok: true });
  }

  const products = (user.workspaces || [])
    .map((workspace) => workspace.workspace)
    .filter((workspace) => workspace !== "ADMIN");
  const verification = await prisma.$transaction(async (tx) =>
    createEmailVerificationLink(tx, { userId: user.id, email, products })
  );

  let sentByEmail = false;
  try {
    sentByEmail = await sendActionLinkEmail({
      to: email,
      subject: "Your mowl signup link",
      headline: "Continue your mowl signup",
      intro: "Use the link below to continue your account setup.",
      actionLabel: "Continue signup",
      actionUrl: verification.verificationLink,
      outro: "This link expires in 30 minutes.",
    });
  } catch (mailErr) {
    console.error("auth.resendEmailOtp mail failed:", mailErr);
  }

  if (!sentByEmail) {
    console.log(
      `[RESEND_SIGNUP_LINK] email=${email} link=${verification.verificationLink} expiresAt=${verification.expiresAt.toISOString()}`
    );
  }

  return res.status(200).json({
    ok: true,
    message: "Verification link resent.",
    dev:
      process.env.NODE_ENV !== "production" && !sentByEmail
        ? { verificationLink: verification.verificationLink, expiresAt: verification.expiresAt }
        : undefined,
  });
}

async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid login data.",
        details: parsed.error.flatten(),
      },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const password = parsed.data.password;
  const now = new Date();

  const throttle = await prisma.loginThrottle.findUnique({
    where: { email },
    select: { failedAttempts: true, lockedUntil: true },
  });

  if (throttle?.lockedUntil && throttle.lockedUntil > now) {
    return res.status(429).json({
      error: {
        code: "LOGIN_TEMP_LOCKED",
        message: "Too many failed attempts. Try again in 2 minutes.",
      },
    });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      fullName: true,
      email: true,
      password: true,
      state: true,
      role: true,
      emailVerifiedAt: true,
      createdAt: true,
    },
  });

  if (!user) {
    const attemptsBefore = throttle?.lockedUntil && throttle.lockedUntil <= now ? 0 : throttle?.failedAttempts || 0;
    const failedAttempts = attemptsBefore + 1;
    const lockedUntil = failedAttempts >= 3 ? new Date(Date.now() + 2 * 60 * 1000) : null;
    await prisma.loginThrottle.upsert({
      where: { email },
      create: { email, failedAttempts, lockedUntil, lastFailedAt: now },
      update: { failedAttempts, lockedUntil, lastFailedAt: now },
    });

    if (lockedUntil) {
      return res.status(429).json({
        error: {
          code: "LOGIN_TEMP_LOCKED",
          message: "Too many failed attempts. Try again in 2 minutes.",
        },
      });
    }

    return res.status(401).json({
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
    });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    const attemptsBefore = throttle?.lockedUntil && throttle.lockedUntil <= now ? 0 : throttle?.failedAttempts || 0;
    const failedAttempts = attemptsBefore + 1;
    const lockedUntil = failedAttempts >= 3 ? new Date(Date.now() + 2 * 60 * 1000) : null;
    await prisma.loginThrottle.upsert({
      where: { email },
      create: { email, failedAttempts, lockedUntil, lastFailedAt: now },
      update: { failedAttempts, lockedUntil, lastFailedAt: now },
    });

    if (lockedUntil) {
      return res.status(429).json({
        error: {
          code: "LOGIN_TEMP_LOCKED",
          message: "Too many failed attempts. Try again in 2 minutes.",
        },
      });
    }

    return res.status(401).json({
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
    });
  }

  // Credentials are valid, clear throttle state for this email.
  await prisma.loginThrottle.delete({ where: { email } }).catch(() => {});

  if (user.state === "INACTIVE" || user.state === "SUSPENDED") {
    return res.status(403).json({
      error: {
        code: "ACCOUNT_INACTIVE",
        message:
          user.state === "SUSPENDED"
            ? "This account has been suspended. Please contact support."
            : "This account is inactive. Please contact support or your administrator.",
      },
    });
  }

  let currentUser = user;
  if (!currentUser.emailVerifiedAt) {
    if (currentUser.role !== "ADMIN") {
      return res.status(403).json({
        error: {
          code: "EMAIL_NOT_VERIFIED",
          message: "Please verify your email from the link we sent before logging in.",
        },
      });
    }

    // Legacy/admin-provisioned admins can be auto-verified at first successful login.
    const now = new Date();
    currentUser = await prisma.user.update({
      where: { id: currentUser.id },
      data: {
        emailVerifiedAt: now,
        state: currentUser.state === "ACTIVE" ? currentUser.state : "ACTIVE",
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        fullName: true,
        email: true,
        password: true,
        state: true,
        role: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });
  }

  const token = signToken({
    userId: currentUser.id,
    email: currentUser.email,
    role: currentUser.role,
  });

  // Don’t send password
  const safe = safeUser(currentUser);

  return res.status(200).json({
    token,
    user: safe,
  });
}

async function me(req, res) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Unauthorized." },
      });
    }

    // ✅ Pull entitlements from DB
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        fullName: true,
        email: true,
        monthlyIncome: true,
        monthlyExpenses: true,
        otherMonthlyEarnings: true,
        state: true,
        role: true,
        createdAt: true,
        workspaces: { select: { workspace: true } }, // ✅ UserWorkspace relation
      },
    });

    if (!user) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "User not found." },
      });
    }

    let entitlements = (user.workspaces || []).map((w) => w.workspace);

    // Backfill only for admin legacy users.
    if (entitlements.length === 0 && user.role === "ADMIN") {
      const defaults = defaultWorkspacesForRole(user.role);
      await prisma.userWorkspace.createMany({
        data: defaults.map((workspace) => ({ userId: user.id, workspace })),
        skipDuplicates: true,
      });
      entitlements = defaults;
    }

    const [rule] = await Promise.all([
      prisma.ruleConfig.findFirst({
        orderBy: { version: "desc" },
        select: { maxDisposableCommitmentPct: true },
      }),
    ]);
    const trust = await getUserTrustProfile(prisma, user.id, {
      baseLimitPct: Number(rule?.maxDisposableCommitmentPct || 0.6),
    });

    return res.status(200).json({
      id: user.id,
      name: user.fullName,
      firstName: user.firstName || null,
      lastName: user.lastName || null,
      email: user.email,
      monthlyIncome: user.monthlyIncome ?? null,
      monthlyExpenses: user.monthlyExpenses ?? null,
      otherMonthlyEarnings: user.otherMonthlyEarnings ?? 0,
      state: user.state,
      role: user.role,
      entitlements,
      products: entitlements,
      affordability: {
        hasIncomeProfile: trust.affordability.hasIncomeProfile,
        hasFinancialProfile: trust.affordability.hasIncomeProfile,
        limitPct: trust.affordability.adjustedLimitPct,
        baseLimitPct: trust.affordability.baseLimitPct,
        trustFactor: trust.trustFactor,
        trustScore: trust.trustScore,
        trustLevel: trust.trustLevel,
        creditScore: trust.creditScore,
        penaltiesTotal: trust.penaltiesTotal,
        currentMonthlyCommitment: trust.affordability.currentMonthlyCommitment,
        monthlyDisposable: trust.affordability.monthlyDisposable,
        maxMonthlyExposure: trust.affordability.maxMonthlyExposure,
        remainingMonthlyCapacity: trust.affordability.remainingMonthlyCapacity,
        yearlyIncomeEstimate: trust.affordability.yearlyIncomeEstimate,
        yearlyDisposableEstimate: trust.affordability.yearlyDisposableEstimate,
      },
      createdAt: user.createdAt,
    });
  } catch (e) {
    console.error("auth.me failed:", e);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load profile." },
    });
  }
}

async function updateFinancialProfile(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Unauthorized." },
    });
  }

  const parsed = financialProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid income profile.",
        details: parsed.error.flatten(),
      },
    });
  }

  const monthlyIncome = parsed.data.monthlyIncome;
  const monthlyExpenses = parsed.data.monthlyExpenses;
  const otherMonthlyEarnings = parsed.data.otherMonthlyEarnings || 0;
  const monthlyDisposable = monthlyIncome + otherMonthlyEarnings - monthlyExpenses;

  if (monthlyDisposable <= 0) {
    return res.status(400).json({
      error: {
        code: "INVALID_FINANCIAL_PROFILE",
        message: "Monthly disposable income must be greater than 0.",
      },
    });
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      monthlyIncome,
      monthlyExpenses,
      otherMonthlyEarnings,
    },
  });

  return res.status(200).json({
    ok: true,
    user: safeUser(updated),
    affordability: {
      monthlyIncome,
      monthlyExpenses,
      otherMonthlyEarnings,
      monthlyDisposable,
      yearlyIncomeEstimate: (monthlyIncome + otherMonthlyEarnings) * 12,
      yearlyDisposableEstimate: monthlyDisposable * 12,
    },
  });
}

async function updateProfile(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Unauthorized." },
    });
  }

  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid profile details.",
        details: parsed.error.flatten(),
      },
    });
  }

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  if (!existing) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "User not found." },
    });
  }

  const firstName = parsed.data.firstName.trim();
  const lastName = parsed.data.lastName.trim();

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      firstName,
      lastName,
      fullName: buildFullName(firstName, lastName),
    },
  });

  return res.status(200).json({
    ok: true,
    user: safeUser(updated),
  });
}

async function changePassword(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Unauthorized." },
    });
  }

  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid password update.",
        details: parsed.error.flatten(),
      },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      password: true,
      firstName: true,
      lastName: true,
    },
  });

  if (!user) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "User not found." },
    });
  }

  const ok = await bcrypt.compare(parsed.data.currentPassword, user.password);
  if (!ok) {
    return res.status(400).json({
      error: { code: "INVALID_PASSWORD", message: "Current password is incorrect." },
    });
  }

  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return res.status(400).json({
      error: { code: "INVALID_PASSWORD", message: "New password must be different from current password." },
    });
  }

  const weakPasswordMessage = assertStrongSignupPassword(parsed.data.newPassword, {
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    email: user.email,
  });

  if (weakPasswordMessage) {
    return res.status(400).json({
      error: { code: "WEAK_PASSWORD", message: weakPasswordMessage },
    });
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { password: passwordHash },
    });
    await tx.passwordResetToken.deleteMany({
      where: { userId },
    });
  });

  return res.status(200).json({
    ok: true,
    message: "Password updated successfully.",
  });
}

module.exports = {
  signup,
  completeSignup,
  getSignupLinkStatus,
  verifyEmailOtp,
  resendEmailOtp,
  updateFinancialProfile,
  updateProfile,
  changePassword,
  login,
  me,
};
