const bcrypt = require("bcrypt");
const { z } = require("zod");
const { prisma } = require("../db");

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).optional(),
  role: z.enum(["USER", "ADMIN"]).default("USER"),
  tempPassword: z.string().min(8).optional(),
});

const updateUserSchema = z.object({
  fullName: z.string().min(2).nullable().optional(),
  role: z.enum(["USER", "ADMIN"]).optional(),
});

exports.listUsers = async (req, res) => {
  try {
    const { search = "", role = "ALL" } = req.query;
    const s = String(search || "").trim();
    const roleFilter = String(role || "ALL").toUpperCase();

    const where = {
      ...(roleFilter !== "ALL" ? { role: roleFilter } : {}),
      ...(s
        ? {
            OR: [
              { email: { contains: s, mode: "insensitive" } },
              { fullName: { contains: s, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        state: true,
        createdAt: true,
      },
      take: 200,
    });

    return res.status(200).json({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        fullName: u.fullName,
        state: u.state,
        createdAt: u.createdAt,
      })),
    });
  } catch (e) {
    console.error("admin.users.list failed:", e);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to load users." },
    });
  }
};

exports.createUser = async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid user payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const { fullName, role, tempPassword } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({
      error: { code: "EMAIL_EXISTS", message: "Email is already registered." },
    });
  }

  const password = tempPassword || "Welcome123!";
  const passwordHash = await bcrypt.hash(password, 12);

  const now = new Date();
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        fullName: fullName || email.split("@")[0],
        password: passwordHash,
        role,
        state: role === "ADMIN" ? "ACTIVE" : "INACTIVE",
        emailVerifiedAt: role === "ADMIN" ? now : null,
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        state: true,
        createdAt: true,
      },
    });

    if (role === "ADMIN") {
      await tx.userWorkspace.createMany({
        data: [{ userId: created.id, workspace: "ADMIN" }],
        skipDuplicates: true,
      });
    }

    return created;
  });

  return res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      state: user.state,
      createdAt: user.createdAt,
    },
    tempPassword: password,
  });
};

exports.updateUser = async (req, res) => {
  const userId = req.params.userId;
  if (!userId) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "userId is required." },
    });
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid update payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "User not found." },
    });
  }

  const { fullName, role } = parsed.data;

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        ...(fullName !== undefined ? { fullName } : {}),
        ...(role ? { role } : {}),
        ...(role === "ADMIN"
          ? {
              emailVerifiedAt: existing.emailVerifiedAt || new Date(),
              state: "ACTIVE",
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        state: true,
        createdAt: true,
      },
    });

    if (role === "ADMIN") {
      await tx.userWorkspace.createMany({
        data: [{ userId, workspace: "ADMIN" }],
        skipDuplicates: true,
      });
    }
    if (role === "USER") {
      await tx.userWorkspace.deleteMany({
        where: { userId, workspace: "ADMIN" },
      });
    }

    return updated;
  });

  return res.status(200).json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      state: user.state,
      createdAt: user.createdAt,
    },
  });
};
