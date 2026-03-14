const { z } = require("zod");
const { prisma } = require("../db");

const reviewSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reviewNote: z.string().max(300).optional(),
});

async function applyApprovedPause(tx, pause) {
  const existing = await tx.contribution.findMany({
    where: {
      planId: pause.planId,
      userId: pause.userId,
      cycleIndex: { gte: pause.startCycleIndex, lte: pause.endCycleIndex },
    },
    select: { id: true, cycleIndex: true, status: true },
  });

  const byCycle = new Map(existing.map((x) => [x.cycleIndex, x]));
  for (let idx = pause.startCycleIndex; idx <= pause.endCycleIndex; idx += 1) {
    const row = byCycle.get(idx);
    if (!row) continue;
    if (["PAID", "LATE", "MISSED"].includes(row.status)) {
      throw {
        status: 409,
        code: "PAUSE_CONFLICT",
        message: `Cannot approve pause: cycle ${idx + 1} already settled (${row.status}).`,
      };
    }
  }

  for (let idx = pause.startCycleIndex; idx <= pause.endCycleIndex; idx += 1) {
    const row = byCycle.get(idx);
    if (!row) {
      await tx.contribution.create({
        data: {
          planId: pause.planId,
          userId: pause.userId,
          amount: 0,
          cycleIndex: idx,
          status: "PAUSED",
          creditsAwarded: 0,
          multiplierApplied: 0,
          paymentRef: pause.paymentRef || `PAUSE-${Date.now()}`,
          paidAt: new Date(),
        },
      });
      continue;
    }
    await tx.contribution.update({
      where: { id: row.id },
      data: {
        amount: 0,
        status: "PAUSED",
        creditsAwarded: 0,
        multiplierApplied: 0,
        paymentRef: pause.paymentRef || `PAUSE-${Date.now()}`,
        paidAt: new Date(),
      },
    });
  }
}

exports.listPauses = async (req, res) => {
  try {
    const status = String(req.query.status || "SUBMITTED").toUpperCase();
    const where = status === "ALL" ? {} : { status };
    const items = await prisma.planPause.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        user: { select: { id: true, email: true, fullName: true } },
        plan: { select: { id: true, name: true, currentCycleIndex: true, assignedPosition: true } },
      },
    });
    return res.json({ items });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "PAUSE_TABLE_NOT_READY",
          message:
            "Pause review columns are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};

exports.reviewPause = async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid payload.", details: parsed.error.flatten() },
    });
  }
  const adminId = req.user?.id || "ADMIN";
  const { pauseId } = req.params;

  try {
    const out = await prisma.$transaction(async (tx) => {
      const pause = await tx.planPause.findUnique({ where: { id: pauseId } });
      if (!pause) throw { status: 404, code: "NOT_FOUND", message: "Pause request not found." };
      if (pause.status !== "SUBMITTED") {
        throw { status: 409, code: "ALREADY_REVIEWED", message: "Pause request already reviewed." };
      }

      if (parsed.data.decision === "REJECT") {
        const rejected = await tx.planPause.update({
          where: { id: pause.id },
          data: {
            status: "REJECTED",
            reviewedById: adminId,
            reviewNote: parsed.data.reviewNote || null,
            reviewedAt: new Date(),
          },
        });
        return rejected;
      }

      await applyApprovedPause(tx, pause);
      const approved = await tx.planPause.update({
        where: { id: pause.id },
        data: {
          status: "APPROVED",
          reviewedById: adminId,
          reviewNote: parsed.data.reviewNote || null,
          reviewedAt: new Date(),
          paidAt: new Date(),
        },
      });
      return approved;
    });

    return res.json({ status: out.status, pause: out });
  } catch (err) {
    if (err?.code === "P2021" || err?.code === "P2022") {
      return res.status(500).json({
        error: {
          code: "PAUSE_TABLE_NOT_READY",
          message:
            "Pause review columns are not ready. Run Prisma migrations, generate client, and restart API.",
        },
      });
    }
    if (err?.status) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
