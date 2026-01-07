const Class = require("../models/class.model");
const User = require("../models/user.model");

// Get all classes
const getAllClasses = async (req, res) => {
  try {
    const classes = await Class.find()
      .populate("createdBy", "firstName lastName")
      .sort({ grade: 1, section: 1 });

    res.json({
      success: true,
      count: classes.length,
      data: classes,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Get single class
const getClass = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.id).populate(
      "createdBy",
      "firstName lastName"
    );

    if (!classData) {
      return res.status(404).json({
        success: false,
        message: "Class not found",
      });
    }

    // Get class students
    const students = await User.find({ class: req.params.id, role: "student" })
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
      message: "Server error",
      error: error.message,
    });
  }
};

// Create new class (Owner only)
const createClass = async (req, res) => {
  try {
    const { name, grade, section } = req.body;

    if (!name || !grade || !section) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be filled",
      });
    }

    const classData = await Class.create({
      name,
      grade,
      section: section.toUpperCase(),
      createdBy: req.user.id,
    });

    const populatedClass = await Class.findById(classData._id).populate(
      "createdBy",
      "firstName lastName"
    );

    res.status(201).json({
      success: true,
      message: "Class successfully created",
      data: populatedClass,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Update class (Owner only)
const updateClass = async (req, res) => {
  try {
    const { name, grade, section, isActive } = req.body;

    const classData = await Class.findById(req.params.id);

    if (!classData) {
      return res.status(404).json({
        success: false,
        message: "Class not found",
      });
    }

    if (name) classData.name = name;
    if (grade) classData.grade = grade;
    if (section) classData.section = section.toUpperCase();
    if (isActive !== undefined) classData.isActive = isActive;

    await classData.save();

    const updatedClass = await Class.findById(classData._id).populate(
      "createdBy",
      "firstName lastName"
    );

    res.json({
      success: true,
      message: "Class successfully updated",
      data: updatedClass,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
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
        message: "Class not found",
      });
    }

    // Check if class has students
    const studentsCount = await User.countDocuments({
      class: req.params.id,
      role: "student",
    });

    if (studentsCount > 0) {
      return res.status(400).json({
        success: false,
        message:
          "This class has students. Please transfer students to another class first",
      });
    }

    await classData.deleteOne();

    res.json({
      success: true,
      message: "Class successfully deleted",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
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
};
