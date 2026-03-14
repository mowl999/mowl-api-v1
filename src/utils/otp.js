const crypto = require("crypto");

function generateOtpCode(length = 6) {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

module.exports = {
  generateOtpCode,
  hashOtp,
};

