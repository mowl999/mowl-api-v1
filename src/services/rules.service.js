const { prisma } = require("../db");

async function getCurrentRuleConfig() {
  // latest by version
  const cfg = await prisma.ruleConfig.findFirst({
    orderBy: { version: "desc" },
  });

  return cfg; // may be null if not seeded
}

module.exports = { getCurrentRuleConfig };
