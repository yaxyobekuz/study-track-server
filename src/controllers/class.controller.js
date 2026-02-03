const ExcelService = require("../services/excel.service");
const Class = require("../models/class.model");
const User = require("../models/user.model");

// Get all classes
const getAllClasses = async (req, res) => {
  try {
    const classes = await Class.find()
      .populate("createdBy", "firstName lastName")
      .sort({ name: 1 })
      .lean();

    res.json({
      success: true,
      count: classes.length,
      data: classes,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get single class
const getClass = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.id).populate(
      "createdBy",
      "firstName lastName",
    );

    if (!classData) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    // Get class students
    const students = await User.find({
      classes: req.params.id,
      role: "student",
    })
      .select("-password")
      .sort({ lastName: 1, firstName: 1 });

    res.json({
      success: true,
      data: {
        ...classData.toObject(),
        students,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Create new class (Owner only)
const createClass = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Sinf nomi majburiy",
      });
    }

    const classData = await Class.create({
      name,
      createdBy: req.user._id,
    });

    const populatedClass = await Class.findById(classData._id).populate(
      "createdBy",
      "firstName lastName",
    );

    res.status(201).json({
      success: true,
      message: "Sinf muvaffaqiyatli yaratildi",
      data: populatedClass,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Update class (Owner only)
const updateClass = async (req, res) => {
  try {
    const { name, isActive } = req.body;

    const classData = await Class.findById(req.params.id);

    if (!classData) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    if (name) classData.name = name;
    if (isActive !== undefined) classData.isActive = isActive;

    await classData.save();

    const updatedClass = await Class.findById(classData._id).populate(
      "createdBy",
      "firstName lastName",
    );

    res.json({
      success: true,
      message: "Sinf muvaffaqiyatli yangilandi",
      data: updatedClass,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Delete class (Owner only)
const deleteClass = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.id);

    if (!classData) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    // Check if class has students
    const studentsCount = await User.countDocuments({
      classes: req.params.id,
      role: "student",
    });

    if (studentsCount > 0) {
      return res.status(400).json({
        success: false,
        message:
          "Bu sinfda o'quvchilar bor. Avval o'quvchilarni boshqa sinfga o'tkazing",
      });
    }

    await classData.deleteOne();

    res.json({
      success: true,
      message: "Sinf muvaffaqiyatli o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Export class students to Excel
const exportClassStudents = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.id);

    if (!classData) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    // Get class students
    const students = await User.find({
      classes: req.params.id,
      role: "student",
    })
      .populate("classes", "name")
      .select("+plainPassword")
      .sort({ firstName: 1, lastName: 1 });

    // Prepare data
    const data = students.map((student) => ({
      fullName: `${student.firstName} ${student.lastName || ""}`.trim(),
      username: student.username,
      password: student.plainPassword || "N/A",
      role: "O'quvchi",
      classes:
        student.classes && student.classes.length > 0
          ? student.classes.map((c) => c.name).join(", ")
          : "-",
    }));

    // Create Excel with service
    const workbook = ExcelService.createExcel({
      sheetName: classData.name,
      columns: [
        { header: "F.I.O", key: "fullName", width: 30 },
        { header: "Username", key: "username", width: 20 },
        { header: "Parol", key: "password", width: 18 },
        { header: "Rol", key: "role", width: 15 },
        { header: "Sinflar", key: "classes", width: 25 },
      ],
      data,
    });

    // Generate filename
    const filename = ExcelService.generateFileName(
      `${classData.name}_oquvchilar`,
    );

    // Send file
    await ExcelService.sendWorkbook(res, workbook, filename);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Export classes to Excel
const exportClasses = async (req, res) => {
  try {
    const classes = await Class.find()
      .populate("createdBy", "firstName lastName")
      .sort({ name: 1 })
      .lean();

    const data = classes.map((classItem) => ({
      name: classItem.name,
      status: classItem.isActive ? "Faol" : "Faol emas",
      createdBy: classItem.createdBy
        ? `${classItem.createdBy.firstName} ${classItem.createdBy.lastName}`
        : "-",
      createdAt: new Date(classItem.createdAt).toLocaleDateString("uz-UZ"),
    }));

    const workbook = ExcelService.createExcel({
      sheetName: "Sinflar",
      columns: [
        { header: "Sinf nomi", key: "name", width: 25 },
        { header: "Holati", key: "status", width: 12 },
        { header: "Yaratuvchi", key: "createdBy", width: 20 },
        { header: "Yaratilgan sana", key: "createdAt", width: 15 },
      ],
      data,
      headerStyle: {
        bgColor: ExcelService.COLORS.HEADER_GREEN,
      },
    });

    const filename = ExcelService.generateFileName("sinflar");
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
  getAllClasses,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  exportClassStudents,
  exportClasses,
};
