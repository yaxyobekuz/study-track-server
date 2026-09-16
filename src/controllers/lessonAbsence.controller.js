const asyncHandler = require("../middleware/async.middleware");
const { getLessonAbsentees } = require("../services/lessonAbsence.service");

/** Boshliq: dars vaqti bo'lgan, lekin maktabda yo'q o'qituvchilar (`?date=YYYY-MM-DD`). */
const getAbsentees = asyncHandler(async (req, res) => {
  const data = await getLessonAbsentees(req.query);
  res.json({ success: true, data });
});

module.exports = { getAbsentees };
