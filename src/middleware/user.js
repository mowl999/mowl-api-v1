// src/middleware/user.js
exports.requireUserRole = (req, res, next) => {
  const role = req.user?.role;
  if (role !== "USER") {
    return res.status(403).json({
      error: { code: "FORBIDDEN", message: "User access required." },
    });
  }
  next();
};