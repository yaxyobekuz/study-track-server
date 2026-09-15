const asyncHandler = require("../middleware/async.middleware");
const { BadRequestError } = require("../utils/errors");
const pushService = require("../services/push.service");

const readToken = (body) => {
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) throw new BadRequestError("token majburiy");
  if (token.length > 512) throw new BadRequestError("token juda uzun");
  return token;
};

/**
 * Mobil qurilmaning FCM tokenini ro'yxatga oladi.
 * Ilova har login'dan keyin va token yangilanganda (`onTokenRefresh`) chaqiradi.
 * POST /push/devices  { token, platform: "android" | "ios" }
 */
const registerDevice = asyncHandler(async (req, res) => {
  const token = readToken(req.body);
  const { platform } = req.body;

  if (platform && !pushService.PLATFORMS.includes(platform)) {
    throw new BadRequestError(
      `platform noto'g'ri: ${pushService.PLATFORMS.join(" | ")} bo'lishi kerak`,
    );
  }

  const device = await pushService.registerDevice({
    token,
    platform,
    userId: req.user.id,
    branchId: req.branch.id,
    jti: req.tokenJti,
  });

  return res.json({
    success: true,
    data: { ...device, pushEnabled: pushService.isEnabled() },
    message: "Qurilma bildirishnomalar uchun ro'yxatga olindi",
  });
});

/**
 * Qurilmani o'chiradi — ilova logout'dan OLDIN chaqiradi.
 * DELETE /push/devices  { token }
 */
const unregisterDevice = asyncHandler(async (req, res) => {
  const token = readToken(req.body);
  const result = await pushService.unregisterDevice({ token, userId: req.user.id });

  return res.json({ success: true, data: result, message: "Qurilma o'chirildi" });
});

module.exports = { registerDevice, unregisterDevice };
