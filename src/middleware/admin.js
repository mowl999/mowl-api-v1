exports.requireAdmin = (req, res, next) => {
  const role = req.user?.role;
  if (role !== "ADMIN") {
    return res.status(403).json({
      error: { code: "FORBIDDEN", message: "Admin access required." },
    });
  }
  next();
};
