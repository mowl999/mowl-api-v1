const { z } = require("zod");
const { prisma } = require("../db");

const PRODUCT_KEYS = ["THRIFT", "INVEST", "LOANS", "FUND_TRANSFERS", "ADMIN"];

const setProductsSchema = z.object({
  products: z.array(z.enum(PRODUCT_KEYS)).default([]),
});

exports.getUserProducts = async (req, res) => {
  const userId = req.params.userId;
  if (!userId) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "userId is required." },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      workspaces: { select: { workspace: true } },
    },
  });

  if (!user) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "User not found." },
    });
  }

  return res.status(200).json({
    userId: user.id,
    email: user.email,
    role: user.role,
    products: (user.workspaces || []).map((w) => w.workspace),
  });
};

exports.setUserProducts = async (req, res) => {
  const userId = req.params.userId;
  if (!userId) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "userId is required." },
    });
  }

  const parsed = setProductsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid products payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  const products = Array.from(new Set(parsed.data.products));

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!user) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "User not found." },
    });
  }

  if (user.role !== "ADMIN" && products.includes("ADMIN")) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Only ADMIN users can be assigned ADMIN product.",
      },
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.userWorkspace.deleteMany({ where: { userId } });
    if (products.length > 0) {
      await tx.userWorkspace.createMany({
        data: products.map((workspace) => ({ userId, workspace })),
        skipDuplicates: true,
      });
    }
  });

  return res.status(200).json({
    userId,
    products,
  });
};
