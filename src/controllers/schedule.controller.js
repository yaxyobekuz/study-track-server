const Schedule = require("../models/schedule.model");
const Class = require("../models/class.model");
const Subject = require("../models/subject.model");
const User = require("../models/user.model");

// Utils va helpers
const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");
const { NotFoundError, ValidationError } = require("../utils/errors");
const asyncHandler = require("../middleware/async.middleware");

// Get all schedules for class
const getScheduleByClass = async (req, res) => {
  try {
    const { classId } = req.params;

    // Check if class exists
    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    const schedules = await Schedule.find({ class: classId })
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName")
      .sort({ day: 1 })
      .lean();

    res.json({
      success: true,
      data: schedules,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get schedule for class and day
const getScheduleByDay = async (req, res) => {
  try {
    const { classId, day } = req.params;

    const schedule = await Schedule.findOne({ class: classId, day })
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName");

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Bu kun uchun dars jadvali topilmadi",
      });
    }

    res.json({
      success: true,
      data: schedule,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Create or update schedule (Owner only)
const createOrUpdateSchedule = async (req, res) => {
  try {
    const { classId, day, subjects } = req.body;

    if (!classId || !day || !subjects || subjects.length === 0) {
      return res.status(400).json({
        success: false,
        message: "All required fields must be filled",
      });
    }

    // Check if class exists
    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    // Validate subjects and teachers
    for (const item of subjects) {
      const subject = await Subject.findById(item.subject);
      if (!subject) {
        return res.status(404).json({
          success: false,
          message: `Fan topilmadi: ${item.subject}`,
        });
      }

      const teacher = await User.findOne({
        _id: item.teacher,
        role: "teacher",
      });
      if (!teacher) {
        return res.status(404).json({
          success: false,
          message: `O'qituvchi topilmadi: ${item.teacher}`,
        });
      }
    }

    // Check if schedule exists
    let schedule = await Schedule.findOne({ class: classId, day });

    if (schedule) {
      // Update existing
      schedule.subjects = subjects;
      await schedule.save();
    } else {
      // Create new
      schedule = await Schedule.create({
        class: classId,
        day,
        subjects,
        createdBy: req.user._id,
      });
    }

    const populatedSchedule = await Schedule.findById(schedule._id)
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName");

    res.json({
      success: true,
      message: "Dars jadvali muvaffaqiyatli saqlandi",
      data: populatedSchedule,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Delete schedule (Owner only)
const deleteSchedule = async (req, res) => {
  try {
    const schedule = await Schedule.findById(req.params.id);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Dars jadvali topilmadi",
      });
    }

    await schedule.deleteOne();

    res.json({
      success: true,
      message: "Dars jadvali muvaffaqiyatli o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get all schedules for today (Owner only)
const getAllTodaySchedules = async (req, res) => {
  try {
    const dayName = getCurrentDayUz();

    // If today is Sunday, return empty array
    if (isSunday()) {
      return res.json({ success: true, data: [] });
    }

    // Find all schedules for today
    const schedules = await Schedule.find({ day: dayName })
      .populate("class", "name")
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName")
      .sort({ "class.name": 1 });

    // Format the response
    const formattedSchedules = schedules.map((schedule) => ({
      class: schedule.class,
      subjects: schedule.subjects.sort((a, b) => a.order - b.order),
    }));

    res.json({ success: true, data: formattedSchedules });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get teacher's schedule for today
const getMyTodaySchedule = async (req, res) => {
  try {
    const teacherId = req.user._id;
    const dayName = getCurrentDayUz();

    // If today is Sunday, return empty array
    if (isSunday()) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Find all schedules for today where teacher has a subject
    const schedules = await Schedule.find({
      day: dayName,
      "subjects.teacher": teacherId,
    })
      .populate("class", "name")
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName");

    // Filter and format teacher's subjects only
    const teacherSchedules = schedules
      .map((schedule) => {
        const teacherSubjects = schedule.subjects
          .filter((item) => item.teacher._id.toString() === teacherId)
          .sort((a, b) => a.order - b.order);

        return {
          class: schedule.class,
          subjects: teacherSubjects,
        };
      })
      .filter((schedule) => schedule.subjects.length > 0);

    res.json({
      success: true,
      data: teacherSchedules,
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
  getScheduleByClass,
  getScheduleByDay,
  createOrUpdateSchedule,
  deleteSchedule,
  getMyTodaySchedule,
  getAllTodaySchedules,
};
