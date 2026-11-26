/**
 * PROFIL RASMI — `/api/profile/avatar`.
 *
 * ⚠️ RUXSAT KALITI YO'Q: odam O'Z rasmini qo'yadi, id tokendan
 * (`/payroll/deductions/my` bilan AYNI qoida).
 *
 * ⚠️ XODIMLAR UCHUN. O'quvchining profil rasmi — PREMIUM moduli qarori
 * (`premium.service.js`) va u o'z yo'lida qoladi: ikki joyda ikki xil
 * shart bo'lsa, o'quvchi premium'siz ham rasm qo'yib olardi.
 *
 * ⚠️ TEZLIK CHEGARASI (10/soat): har almashtirish Spaces'ga 4 ta fayl
 * yozadi (original + sm/md/lg) va eskisini o'chiradi.
 */

const express = require("express");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { createSingleFileUpload } = require("../middleware/fileUpload.middleware");
const socialAccess = require("../services/socialAccess.service");
const controller = require("../controllers/profile.controller");

const avatarLimiter = rateLimit({
  max: 10,
  windowMs: 60 * 60 * 1000,
  keyGenerator: (req) => (req.user?.id ? String(req.user.id) : ipKeyGenerator(req.ip)),
  message: { success: false, message: "Avatar juda tez almashtirildi — bir soatdan keyin" },
});

router.use(protect);
router.use((req, res, next) => {
  socialAccess.assertStaff(req.user, req.sessionChannel);
  next();
});

router.put(
  "/avatar",
  avatarLimiter,
  // ⚠️ Maydon nomi `image` — premium profil rasmi bilan AYNI
  // (`premium.routes.js`): mobil tomonda bitta yuklash kodi ikki yo'lda
  // ishlatiladi.
  ...createSingleFileUpload({ fieldName: "image", categories: ["image"] }),
  controller.uploadAvatar,
);
router.put("/avatar/preset", avatarLimiter, controller.setPreset);
router.delete("/avatar", avatarLimiter, controller.removeAvatar);

module.exports = router;
