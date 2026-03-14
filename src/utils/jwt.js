const jwt = require("jsonwebtoken");

exports.signToken = (user) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set in .env");

  const userId = String(user?.id || user?.userId || "");
  if (!userId) throw new Error("Cannot sign token: user id is missing.");

  return jwt.sign(
    { email: user.email, role: user.role }, // 👈 add role
    secret,
    {
      subject: String(userId),     // ✅ always a string
      expiresIn: "7d",
    }
  );
};
