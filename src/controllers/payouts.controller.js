const { prisma } = require("../db");

// PATCH /v1/payouts/:payoutId/mark-sent
exports.markPayoutSent = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { payoutId } = req.params;
    const { reference, note, sentAt } = req.body;

    const updated = await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.findUnique({
        where: { id: payoutId },
        select: { id: true, planId: true, status: true, recipientType: true },
      });

      if (!payout) throw { status: 404, code: "NOT_FOUND", message: "Payout not found." };

      const plan = await tx.plan.findUnique({
        where: { id: payout.planId },
        select: { id: true, userId: true },
      });

      if (!plan) throw { status: 404, code: "NOT_FOUND", message: "Plan not found for payout." };
      if (plan.userId !== userId) throw { status: 403, code: "FORBIDDEN", message: "No access." };

      if (payout.recipientType === "VIRTUAL") {
        // already auto-sent; block manual changes to keep it clean
        throw { status: 409, code: "VIRTUAL_PAYOUT", message: "Virtual payouts are auto-sent." };
      }

      if (payout.status !== "PENDING") {
        throw { status: 409, code: "INVALID_STATE", message: `Payout is already ${payout.status}.` };
      }

      const upd = await tx.payout.update({
        where: { id: payout.id },
        data: {
          status: "SENT",
          reference: reference || null,
          note: note || null,
          sentAt: sentAt ? new Date(sentAt) : new Date(),
        },
      });

      // If you have DecisionLog, keep it. If not, delete this block.
      await tx.decisionLog.create({
        data: {
          decisionType: "PAYOUT_SENT",
          userId,
          planId: plan.id,
          inputs: { payoutId: payout.id, reference: reference || null },
          ruleApplied: "MANUAL_CONFIRMATION",
          outcome: { status: "SENT" },
        },
      });

      return upd;
    });

    return res.json({
      status: "PAYOUT_MARKED_SENT",
      payout: {
        id: updated.id,
        planId: updated.planId,
        cycleIndex: updated.cycleIndex,
        amount: updated.amount,
        currency: updated.currency,
        recipientName: updated.recipientName,
        recipientPosition: updated.recipientPosition,
        recipientType: updated.recipientType,
        status: updated.status,
        sentAt: updated.sentAt,
        reference: updated.reference,
        note: updated.note,
      },
    });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong." } });
  }
};
