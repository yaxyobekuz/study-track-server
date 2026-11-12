/**
 * O'QUVCHINING SHAXSIY MAVZU REJASI (`/student-topic-plans`).
 *
 * ⚠️ RUXSAT — `topics.view` / `topics.assign`, ALOHIDA KALIT EMAS. Sabab:
 * bu AYNI qaror, faqat o'quvchi kesimida — "darsga mavzu biriktirish"
 * (`topics.assign`) va "bu bola qaysi mavzuda" bitta ishning ikki
 * tomoni. Uchinchi kalit qo'shilsa, mavzu biriktiradigan odam yarim
 * huquq bilan qolib, ekranning bir qismi 403 bo'lib turardi.
 *
 * ⚠️ `schedules.update` YETMAYDI (`topics.assign` doktrinasi,
 * `education.md` §13): jadval tuzuvchi kataklarni joylashtiradi,
 * o'quvchining mavzu o'rnini esa o'quv bo'limi belgilaydi — u diagnostika
 * testining qamrovini ham o'zgartiradi.
 */

const express = require("express");
const router = express.Router();

const {
  listClassStudentTopics,
  setStudentTopicPlans,
  revokeStudentTopicPlan,
  listStudentTopicPlans,
} = require("../controllers/studentTopicPlan.controller");

const { protect, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");

router.use(protect);

// ⚠️ `/history` `/:id` dan OLDIN: aks holda "history" id deb o'qilib,
// `validateObjectId` so'rovni rad etardi.
router.get("/history", authorizePermission(PERMISSIONS.TOPICS_VIEW), listStudentTopicPlans);

router.get("/", authorizePermission(PERMISSIONS.TOPICS_VIEW), listClassStudentTopics);
router.post("/", authorizePermission(PERMISSIONS.TOPICS_ASSIGN), setStudentTopicPlans);
router.delete(
  "/:id",
  validateObjectId("id"),
  authorizePermission(PERMISSIONS.TOPICS_ASSIGN),
  revokeStudentTopicPlan,
);

module.exports = router;
