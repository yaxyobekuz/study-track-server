/**
 * PROFIL RASMI (AVATAR) — controller.
 *
 * Qoida va saqlash joyi `avatar.service.js` da: rasm odamning UY
 * filialida, havolasi esa platformadagi `user_directory` da.
 */

const asyncHandler = require("../middleware/async.middleware");
const avatarService = require("../services/avatar.service");

const uploadAvatar = asyncHandler(async (req, res) => {
  const data = await avatarService.uploadAvatar({ actor: req.user, file: req.file });
  res.json({ success: true, data, message: "Profil rasmi saqlandi" });
});

const setPreset = asyncHandler(async (req, res) => {
  const data = await avatarService.setPreset({ actor: req.user, preset: req.body?.preset });
  res.json({ success: true, data, message: "Avatar tanlandi" });
});

const removeAvatar = asyncHandler(async (req, res) => {
  const data = await avatarService.removeAvatar({ actor: req.user });
  res.json({ success: true, data, message: "Profil rasmi olib tashlandi" });
});

module.exports = { uploadAvatar, setPreset, removeAvatar };
