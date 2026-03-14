const { z } = require("zod");
const { prisma } = require("../db");

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reviewNote: z.string().max(300).optional(),
});

async function applyApprovedSwap(tx, swap) {
  const plan = await tx.plan.findUnique({
    where: { id: swap.planId },
    select: {
      id: true,
      assignedPosition: true,
      swapsUsed: true,
      feePoolAmount: true,
      memberCount: true,
      currentCycleIndex: true,
    },
  });
  if (!plan) throw { status: 404, code: "NOT_FOUND", message: "Plan not found for swap." };

  if (plan.currentCycleIndex >= swap.toPosition) {
    throw {
      status: 409,
      code: "PAYOUT_WINDOW_PASSED",
      message: "Cannot approve swap because target payout month has already passed.",
    };
  }

  const realMember = await tx.planMember.findFirst({
    where: { planId: swap.planId, type: "REAL" },
    select: { id: true, position: true },
  });
  if (!realMember) throw { status: 404, code: "NOT_FOUND", message: "Real member not found for plan." };

  if (realMember.position !== swap.fromPosition || plan.assignedPosition !== swap.fromPosition) {
    throw {
      status: 409,
      code: "SWAP_STALE_REQUEST",
      message: "Swap request no longer matches current plan position.",
      details: { currentPosition: realMember.position, requestedFromPosition: swap.fromPosition },
    };
  }

  const targetMember = await tx.planMember.findFirst({
    where: { planId: swap.planId, position: swap.toPosition },
    select: { id: true, type: true },
  });
  if (!targetMember) {
    throw { status: 404, code: "NOT_FOUND", message: "Target position member not found for swap." };
  }

  // Three-step swap to avoid unique(planId, position) conflict.
  await tx.planMember.update({
    where: { id: realMember.id },
    data: { position: 0 },
  });
  await tx.planMember.update({
    where: { id: targetMember.id },
    data: { position: swap.fromPosition },
  });
  await tx.planMember.update({
    where: { id: realMember.id },
    data: { position: swap.toPosition },
  });

  const updatedPlan = await tx.plan.update({
    where: { id: plan.id },
    data: {
      assignedPosition: swap.toPosition,
      swapsUsed: plan.swapsUsed + 1,
      feePoolAmount: Number(plan.feePoolAmount || 0) + Number(swap.feeCharged || 0),
    },
    select: {
      id: true,
      assignedPosition: true,
      swapsUsed: true,
      feePoolAmount: true,
    },
  });

  return updatedPlan;
}

exports.listSwaps = async (req, res) => {
  try {
    const status = String(req.query.status || "SUBMITTED").toUpperCase();
    const where = status === "ALL" ? {} : { status };

    const items = await prisma.swap.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        planId: true,
        userId: true,
        fromPosition: true,
        toPosition: true,
        steps: true,
        feeCharged: true,
        status: true,
        reviewedById: true,
        reviewNote: true,
        reviewedAt: true,
        createdAt: true,
        user: { select: { id: true, email: true, fullName: true } },
        plan: {
          select: {
            id: true,
            name: true,
            assignedPosition: true,
            currentCycleIndex: true,
          },
        },
      },
    });

    return res.json({ items });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "SWAP_TABLE_NOT_READY",
          message:
            "Swap request columns are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

function resolveRangeStart(range) {
  const now = new Date();
  if (range === "7d") {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (range === "30d") {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return null;
}

exports.getSwapLedger = async (req, res) => {
  try {
    const range = String(req.query.range || "all").toLowerCase();
    if (!["7d", "30d", "all"].includes(range)) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid range. Use one of: 7d, 30d, all.",
        },
      });
    }

    const start = resolveRangeStart(range);
    const dateFilter = start ? { createdAt: { gte: start } } : {};

    const [approvedAgg, pendingAgg, approvedCount, pendingCount, rejectedCount] = await Promise.all([
      prisma.swap.aggregate({
        where: { status: "APPROVED", ...dateFilter },
        _sum: { feeCharged: true },
      }),
      prisma.swap.aggregate({
        where: { status: "SUBMITTED", ...dateFilter },
        _sum: { feeCharged: true },
      }),
      prisma.swap.count({ where: { status: "APPROVED", ...dateFilter } }),
      prisma.swap.count({ where: { status: "SUBMITTED", ...dateFilter } }),
      prisma.swap.count({ where: { status: "REJECTED", ...dateFilter } }),
    ]);

    return res.json({
      range,
      totals: {
        totalFeesCollected: Number(approvedAgg?._sum?.feeCharged || 0),
        pendingExposure: Number(pendingAgg?._sum?.feeCharged || 0),
      },
      counts: {
        approvedSwaps: approvedCount,
        pendingSwaps: pendingCount,
        rejectedSwaps: rejectedCount,
      },
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "SWAP_TABLE_NOT_READY",
          message:
            "Swap request columns are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.reviewSwap = async (req, res) => {
  const adminId = req.user?.id || "ADMIN";
  const { swapId } = req.params;
  const parsed = reviewSchema.safeParse(req.body || {});

  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid review payload.",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const out = await prisma.$transaction(async (tx) => {
      const swap = await tx.swap.findUnique({
        where: { id: swapId },
        select: {
          id: true,
          planId: true,
          userId: true,
          fromPosition: true,
          toPosition: true,
          steps: true,
          feeCharged: true,
          status: true,
        },
      });
      if (!swap) throw { status: 404, code: "NOT_FOUND", message: "Swap request not found." };
      if (swap.status !== "SUBMITTED") {
        throw { status: 409, code: "ALREADY_REVIEWED", message: "Swap request already reviewed." };
      }

      if (parsed.data.decision === "REJECT") {
        const rejected = await tx.swap.update({
          where: { id: swap.id },
          data: {
            status: "REJECTED",
            reviewedById: adminId,
            reviewedAt: new Date(),
            reviewNote: parsed.data.reviewNote || "Rejected by admin",
          },
        });

        await tx.decisionLog.create({
          data: {
            decisionType: "SWAP_REVIEW",
            userId: swap.userId,
            planId: swap.planId,
            inputs: { swapId: swap.id, decision: "REJECT" },
            ruleApplied: "ADMIN_REVIEW",
            outcome: { status: "REJECTED" },
          },
        });

        return { swap: rejected, plan: null };
      }

      const updatedPlan = await applyApprovedSwap(tx, swap);

      const approved = await tx.swap.update({
        where: { id: swap.id },
        data: {
          status: "APPROVED",
          reviewedById: adminId,
          reviewedAt: new Date(),
          reviewNote: parsed.data.reviewNote || "Approved by admin",
        },
      });

      await tx.decisionLog.create({
        data: {
          decisionType: "SWAP_REVIEW",
          userId: swap.userId,
          planId: swap.planId,
          inputs: { swapId: swap.id, decision: "APPROVE", fromPos: swap.fromPosition, toPos: swap.toPosition },
          ruleApplied: "ADMIN_REVIEW",
          outcome: {
            status: "APPROVED",
            newPosition: updatedPlan.assignedPosition,
            swapsUsed: updatedPlan.swapsUsed,
            feePoolAmount: updatedPlan.feePoolAmount,
          },
        },
      });

      return { swap: approved, plan: updatedPlan };
    });

    return res.json({ status: out.swap.status, swap: out.swap, plan: out.plan });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "SWAP_TABLE_NOT_READY",
          message:
            "Swap request columns are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
