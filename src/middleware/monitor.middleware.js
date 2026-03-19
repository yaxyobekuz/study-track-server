const Monitor = require("../models/monitor.model");

/**
 * Monitor kodini tekshiruvchi middleware.
 * x-monitor-code headerdan kodni o'qiydi va bazadan tekshiradi.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
const verifyMonitor = async (req, res, next) => {
  try {
    const code = req.headers["x-monitor-code"];

    if (!code) {
      return res.status(401).json({
        success: false,
        message: "Monitor kodi taqdim etilmagan",
      });
    }

    const monitor = await Monitor.findOne({ code, isActive: true });

    if (!monitor) {
      return res.status(401).json({
        success: false,
        message: "Monitor kodi noto'g'ri yoki faol emas",
      });
    }

    req.monitor = monitor;
    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

module.exports = { verifyMonitor };
