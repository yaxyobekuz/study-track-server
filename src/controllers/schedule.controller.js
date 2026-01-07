const Schedule = require('../models/schedule.model');
const Class = require('../models/class.model');
const Subject = require('../models/subject.model');
const User = require('../models/user.model');

// Get all schedules for class
const getScheduleByClass = async (req, res) => {
  try {
    const { classId } = req.params;

    // Check if class exists
    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    const schedules = await Schedule.find({ class: classId })
      .populate('subjects.subject', 'name')
      .populate('subjects.teacher', 'firstName lastName')
      .sort({ day: 1 });

    res.json({
      success: true,
      data: schedules
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Get schedule for class and day
const getScheduleByDay = async (req, res) => {
  try {
    const { classId, day } = req.params;

    const schedule = await Schedule.findOne({ class: classId, day })
      .populate('subjects.subject', 'name')
      .populate('subjects.teacher', 'firstName lastName');

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Schedule not found for this day'
      });
    }

    res.json({
      success: true,
      data: schedule
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
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
        message: 'All required fields must be filled'
      });
    }

    // Check if class exists
    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }

    // Validate subjects and teachers
    for (const item of subjects) {
      const subject = await Subject.findById(item.subject);
      if (!subject) {
        return res.status(404).json({
          success: false,
          message: `Subject not found: ${item.subject}`
        });
      }

      const teacher = await User.findOne({ _id: item.teacher, role: 'teacher' });
      if (!teacher) {
        return res.status(404).json({
          success: false,
          message: `Teacher not found: ${item.teacher}`
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
        createdBy: req.user.id
      });
    }

    const populatedSchedule = await Schedule.findById(schedule._id)
      .populate('subjects.subject', 'name')
      .populate('subjects.teacher', 'firstName lastName');

    res.json({
      success: true,
      message: 'Dars jadvali muvaffaqiyatli saqlandi',
      data: populatedSchedule
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
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
        message: 'Dars jadvali topilmadi'
      });
    }

    await schedule.deleteOne();

    res.json({
      success: true,
      message: 'Dars jadvali muvaffaqiyatli o\'chirildi'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
    });
  }
};

module.exports = {
  getScheduleByClass,
  getScheduleByDay,
  createOrUpdateSchedule,
  deleteSchedule,
};
