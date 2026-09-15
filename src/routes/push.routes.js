/**
 * MOBIL PUSH — qurilma reyestri.
 *
 * Ruxsat talab qilinmaydi: har kim faqat O'ZINING qurilmasini yozadi va
 * o'chiradi (`userId` tokendan olinadi, so'rov tanasidan emas).
 */

const express = require("express");
const router = express.Router();

const { protect } = require("../middleware/auth.middleware");
const { registerDevice, unregisterDevice } = require("../controllers/push.controller");

router.use(protect);

router.post("/devices", registerDevice);
router.delete("/devices", unregisterDevice);

module.exports = router;
