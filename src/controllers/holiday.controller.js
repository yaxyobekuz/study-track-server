const asyncHandler = require("../middleware/async.middleware");
const holidayService = require("../services/holiday.service");

/**
 * Barcha dam olish kunlarini olish
 * GET /api/holidays
 */
const getHolidays = asyncHandler(async (req, res) => {
  const holidays = await holidayService.getHolidays();

  res.json({
    success: true,
    data: holidays,
  });
});

/**
 * Dam olish kuni yaratish
 * POST /api/holidays
 */
const createHoliday = asyncHandler(async (req, res) => {
  const holiday = await holidayService.createHoliday(req.body, req.user._id);

  res.status(201).json({
    success: true,
    data: holiday,
  });
});

/**
 * Dam olish kunini yangilash
 * PUT /api/holidays/:id
 */
const updateHoliday = asyncHandler(async (req, res) => {
  const holiday = await holidayService.updateHoliday(req.params.id, req.body);

  res.json({
    success: true,
    data: holiday,
  });
});

/**
 * Dam olish kunini o'chirish
 * DELETE /api/holidays/:id
 */
const deleteHoliday = asyncHandler(async (req, res) => {
  await holidayService.deleteHoliday(req.params.id);

  res.json({
    success: true,
    message: "Dam olish kuni o'chirildi",
  });
});

/**
 * Bugun dam olish kuni ekanligini tekshirish
 * GET /api/holidays/check/today
 */
const checkToday = asyncHandler(async (req, res) => {
  const result = await holidayService.checkToday();

  res.json({
    success: true,
    data: result,
  });
});

/**
 * Ma'lum sanani tekshirish
 * GET /api/holidays/check/:date
 */
const checkDate = asyncHandler(async (req, res) => {
  const result = await holidayService.checkDate(req.params.date);

  res.json({
    success: true,
    data: result,
  });
});

module.exports = {
  getHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  checkToday,
  checkDate,
};
