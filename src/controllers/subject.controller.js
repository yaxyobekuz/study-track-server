const Grade = require("../models/grade.model");
const Subject = require("../models/subject.model");
const Schedule = require("../models/schedule.model");
const ExcelService = require("../services/excel.service");

// Get all subjects
const getAllSubjects = async (req, res) => {
  try {
    const subjects = await Subject.find()
      .populate("createdBy", "firstName lastName")
      .sort({ name: 1 })
      .lean();

    res.json({
      success: true,
      count: subjects.length,
      data: subjects,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Create new subject (Owner only)
const createSubject = async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Fan nomi majburiy",
      });
    }

    const subject = await Subject.create({
      name,
      description,
      createdBy: req.user._id,
    });

    res.status(201).json({
      success: true,
      message: "Fan muvaffaqiyatli yaratildi",
      data: subject,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Update subject (Owner only)
const updateSubject = async (req, res) => {
  try {
    const { name, description, isActive } = req.body;

    const subject = await Subject.findById(req.params.id);

    if (!subject) {
      return res.status(404).json({
        success: false,
        message: "Fan topilmadi",
      });
    }

    if (name) subject.name = name;
    if (description !== undefined) subject.description = description;
    if (isActive !== undefined) subject.isActive = isActive;

    await subject.save();

    res.json({
      success: true,
      message: "Fan muvaffaqiyatli yangilandi",
      data: subject,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Delete subject (Owner only)
const deleteSubject = async (req, res) => {
  try {
    const subject = await Subject.findById(req.params.id);

    if (!subject) {
      return res.status(404).json({
        success: false,
        message: "Fan topilmadi",
      });
    }

    // Check if subject is used in grades or schedules
    const [gradesCount, schedulesCount] = await Promise.all([
      Grade.countDocuments({ subject: subject._id }),
      Schedule.countDocuments({ "subjects.subject": subject._id }),
    ]);

    if (gradesCount > 0 || schedulesCount > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Bu fan baholarda yoki jadvallarda ishlatilmoqda. Avval ularni o'chiring.",
      });
    }

    await subject.deleteOne();

    res.json({
      success: true,
      message: "Fan muvaffaqiyatli o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Export subjects to Excel
const exportSubjects = async (req, res) => {
  try {
    const subjects = await Subject.find()
      .populate("createdBy", "firstName lastName")
      .sort({ name: 1 })
      .lean();

    // Excel uchun ma'lumotlarni tayyorlash
    const data = subjects.map((subject) => ({
      name: subject.name,
      description: subject.description || "-",
      status: subject.isActive ? "Faol" : "Faol emas",
      createdBy: subject.createdBy
        ? `${subject.createdBy.firstName} ${subject.createdBy.lastName}`
        : "-",
      createdAt: new Date(subject.createdAt).toLocaleDateString("uz-UZ"),
    }));

    // Excel yaratish
    const workbook = ExcelService.createExcel({
      sheetName: "Fanlar",
      columns: [
        { header: "Fan nomi", key: "name", width: 25 },
        { header: "Tavsif", key: "description", width: 40 },
        { header: "Holati", key: "status", width: 12 },
        { header: "Yaratuvchi", key: "createdBy", width: 20 },
        { header: "Yaratilgan sana", key: "createdAt", width: 15 },
      ],
      data,
      headerStyle: {
        bgColor: ExcelService.COLORS.HEADER_PURPLE,
      },
    });

    // Fayl nomini yaratish
    const filename = ExcelService.generateFileName("fanlar");

    // Faylni yuborish
    await ExcelService.sendWorkbook(res, workbook, filename);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

module.exports = {
  getAllSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  exportSubjects,
};
