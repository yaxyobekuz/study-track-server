// Models
const Holiday = require("../models/holiday.model");

/**
 * Barcha dam olish kunlarini
 * GET /api/holidays
 */
const getHolidays = async (req, res) => {
  try {
    const holidays = await Holiday.find()
      .populate("createdBy", "firstName lastName")
      .sort({ createdAt: -1 });
    res.json({
      success: true,
      count: holidays.length,
      data: holidays,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Dam olish kuni yaratish
 * POST /api/holidays
 */
const createHoliday = async (req, res) => {
  try {
    const {
      name,
      description,
      type,
      date,
      startDate,
      endDate,
      recurringDate,
      recurringStartDate,
      recurringEndDate,
      isActive,
    } = req.body;

    // Validatsiya
    if (!name || !type) {
      return res.status(400).json({
        success: false,
        message: "Nom va turi majburiy",
      });
    }

    // Turga qarab validatsiya
    if (type === "single" && !date) {
      return res.status(400).json({
        success: false,
        message: "Bir kunlik dam olish uchun sana majburiy",
      });
    }

    if (type === "range" && (!startDate || !endDate)) {
      return res.status(400).json({
        success: false,
        message: "Vaqt oralig'i uchun boshlanish va tugash sanasi majburiy",
      });
    }

    if (type === "recurring") {
      const hasRecurringDate =
        recurringDate &&
        recurringDate.month !== undefined &&
        recurringDate.day !== undefined;
      const hasRecurringRange =
        recurringStartDate &&
        recurringEndDate &&
        recurringStartDate.month !== undefined &&
        recurringEndDate.month !== undefined;

      if (!hasRecurringDate && !hasRecurringRange) {
        return res.status(400).json({
          success: false,
          message:
            "Takrorlanuvchi dam olish uchun sana yoki oraliq kiritish majburiy",
        });
      }
    }

    const holiday = await Holiday.create({
      name,
      description,
      type,
      date,
      startDate,
      endDate,
      recurringDate,
      recurringStartDate,
      recurringEndDate,
      isActive: isActive !== undefined ? isActive : true,
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      data: holiday,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Dam olish kunini yangilash
 * PUT /api/holidays/:id
 */
const updateHoliday = async (req, res) => {
  try {
    const { id } = req.params;

    const holiday = await Holiday.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!holiday) {
      return res.status(404).json({
        success: false,
        message: "Dam olish kuni topilmadi",
      });
    }

    res.json({
      success: true,
      data: holiday,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Dam olish kunini o'chirish
 * DELETE /api/holidays/:id
 */
const deleteHoliday = async (req, res) => {
  try {
    const { id } = req.params;

    const holiday = await Holiday.findByIdAndDelete(id);

    if (!holiday) {
      return res.status(404).json({
        success: false,
        message: "Dam olish kuni topilmadi",
      });
    }

    res.json({
      success: true,
      message: "Dam olish kuni o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Bugun dam olish kuni ekanligini tekshirish
 * GET /api/holidays/check/today
 */
const checkToday = async (req, res) => {
  try {
    const result = await Holiday.isHoliday(new Date());

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

/**
 * Ma'lum sanani tekshirish
 * GET /api/holidays/check/:date
 */
const checkDate = async (req, res) => {
  try {
    const { date } = req.params;
    const result = await Holiday.isHoliday(new Date(date));

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

module.exports = {
  getHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  checkToday,
  checkDate,
};
