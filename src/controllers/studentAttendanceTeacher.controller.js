/**
 * O'QITUVCHINING O'Z DARSIGA DAVOMATI — HTTP qatlami.
 *
 * Qoida va darvozalar servisda (`studentAttendanceTeacher.service.js`):
 * bu yerda faqat so'rovdan maydon olish va javob shakli. O'qituvchi id si
 * HAR DOIM tokendan (`req.user`) — so'rov tanasidan OLINMAYDI.
 */

const asyncHandler = require("../middleware/async.middleware");
const service = require("../services/studentAttendanceTeacher.service");

/** Bugun davomat belgilanadigan sinflar (darslar + yig'indi). */
const getDay = asyncHandler(async (req, res) => {
  const data = await service.getTeacherDay(req.user, { date: req.query.date });
  res.json({ success: true, data });
});

/** Bitta sinfning bugungi ro'yxati. */
const getClassRoster = asyncHandler(async (req, res) => {
  const data = await service.getTeacherClassRoster(req.user, {
    classId: req.params.classId,
    date: req.query.date,
  });
  res.json({ success: true, data });
});

/** Belgilash — `{ classId, date?, records: [{ studentId, status, excuseReason }] }`. */
const mark = asyncHandler(async (req, res) => {
  const { classId, date, records } = req.body;
  const data = await service.markTeacherAttendance(req.user, {
    classId,
    date,
    records,
  });
  res.json({ success: true, data });
});

module.exports = { getDay, getClassRoster, mark };
