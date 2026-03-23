const Monitor = require("../models/monitor.model");
const asyncHandler = require("./async.middleware");
const { UnauthorizedError } = require("../utils/errors");

/**
 * Monitor kodini tekshiruvchi middleware.
 * x-monitor-code headerdan kodni o'qiydi va bazadan tekshiradi.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
const verifyMonitor = asyncHandler(async (req, res, next) => {
  const code = req.headers["x-monitor-code"];

  if (!code) {
    throw new UnauthorizedError("Monitor kodi taqdim etilmagan");
  }

  const monitor = await Monitor.findOne({ code, isActive: true });

  if (!monitor) {
    throw new UnauthorizedError("Monitor kodi noto'g'ri yoki faol emas");
  }

  req.monitor = monitor;
  next();
});

module.exports = { verifyMonitor };
