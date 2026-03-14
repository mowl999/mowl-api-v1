const jwt = require("jsonwebtoken");

exports.requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing Bearer token." },
    });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const id = payload.sub || payload.userId; // ✅ supports both styles
    if (!id) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Token missing user identity." },
      });
    }

   req.user = { id, email: payload.email, role: payload.role };
    return next();
  } catch (e) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Invalid or expired token." },
    });
  }
};
