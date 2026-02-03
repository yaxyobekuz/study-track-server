const ExcelService = require("../services/excel.service");
const Schedule = require("../models/schedule.model");
const Class = require("../models/class.model");
const Subject = require("../models/subject.model");
const User = require("../models/user.model");
const Topic = require("../models/topic.model");

// Utils va helpers
const { getCurrentDayUz, isSunday } = require("../helpers/date.helpers");

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
    const { classId, day, subjects, startingOrder } = req.body;

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
      // Validate time fields (only if times are provided)
      if (item.startTime || item.endTime) {
        // If one time is set, both must be set
        if (!item.startTime || !item.endTime) {
          return res.status(400).json({
            success: false,
            message: `${item.order}-dars: boshlanish va tugash vaqti ikkalasi ham kiritilishi kerak`,
          });
        }

        // Validate time format (HH:mm)
        const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
        if (!timeRegex.test(item.startTime) || !timeRegex.test(item.endTime)) {
          return res.status(400).json({
            success: false,
            message: `${item.order}-dars: vaqt formati noto'g'ri (HH:mm formatida bo'lishi kerak)`,
          });
        }

        // Validate startTime < endTime
        if (item.startTime >= item.endTime) {
          return res.status(400).json({
            success: false,
            message: `${item.order}-dars: boshlanish vaqti tugash vaqtidan oldin bo'lishi kerak`,
          });
        }
      }

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

    // Check for time overlaps (only for lessons with times)
    const subjectsWithTimes = subjects.filter(s => s.startTime && s.endTime);
    if (subjectsWithTimes.length > 0) {
      const sortedSubjects = [...subjectsWithTimes].sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (let i = 0; i < sortedSubjects.length - 1; i++) {
        if (sortedSubjects[i].endTime > sortedSubjects[i + 1].startTime) {
          return res.status(400).json({
            success: false,
            message: `Darslar vaqtlari to'qnashib ketdi: ${sortedSubjects[i].order}-dars (${sortedSubjects[i].startTime}-${sortedSubjects[i].endTime}) va ${sortedSubjects[i + 1].order}-dars (${sortedSubjects[i + 1].startTime}-${sortedSubjects[i + 1].endTime})`,
          });
        }
      }
    }

    // Check if schedule exists
    let schedule = await Schedule.findOne({ class: classId, day });

    if (schedule) {
      // Update existing
      schedule.subjects = subjects;
      schedule.startingOrder = startingOrder || 1;
      await schedule.save();
    } else {
      // Create new
      schedule = await Schedule.create({
        class: classId,
        day,
        subjects,
        startingOrder: startingOrder || 1,
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

// Export schedules for class to Excel
const exportScheduleByClass = async (req, res) => {
  try {
    const { classId } = req.params;

    const classDoc = await Class.findById(classId);
    if (!classDoc) {
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

    const dayOrder = [
      "dushanba",
      "seshanba",
      "chorshanba",
      "payshanba",
      "juma",
      "shanba",
      "yakshanba",
    ];

    const dayRank = new Map(dayOrder.map((day, index) => [day, index]));

    const sortedSchedules = [...schedules].sort((a, b) => {
      const rankA = dayRank.has(a.day) ? dayRank.get(a.day) : 999;
      const rankB = dayRank.has(b.day) ? dayRank.get(b.day) : 999;
      return rankA - rankB;
    });

    const data = [];

    sortedSchedules.forEach((schedule) => {
      const subjects = [...(schedule.subjects || [])].sort(
        (a, b) => (a.order || 0) - (b.order || 0),
      );

      if (subjects.length === 0) {
        data.push({
          day: schedule.day,
          order: "-",
          subject: "-",
          teacher: "-",
          time: "-",
        });
        return;
      }

      subjects.forEach((subj, index) => {
        const displayOrder =
          (schedule.startingOrder || 1) + (subj.order || index + 1) - 1;
        const teacherName = subj.teacher
          ? `${subj.teacher.firstName} ${subj.teacher.lastName || ""}`.trim()
          : "-";
        const time =
          subj.startTime && subj.endTime
            ? `${subj.startTime} - ${subj.endTime}`
            : "-";

        data.push({
          day: schedule.day,
          order: displayOrder,
          subject: subj.subject?.name || "-",
          teacher: teacherName,
          time,
        });
      });
    });

    const workbook = ExcelService.createExcel({
      sheetName: classDoc.name,
      columns: [
        { header: "Kun", key: "day", width: 15 },
        { header: "Dars", key: "order", width: 8 },
        { header: "Fan", key: "subject", width: 30 },
        { header: "O'qituvchi", key: "teacher", width: 25 },
        { header: "Vaqt", key: "time", width: 15 },
      ],
      data,
      headerStyle: {
        bgColor: ExcelService.COLORS.HEADER_ORANGE,
      },
    });

    const filename = ExcelService.generateFileName(
      `dars_jadvali_${classDoc.name}`,
    );
    await ExcelService.sendWorkbook(res, workbook, filename);
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
      startingOrder: schedule.startingOrder || 1,
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
      "subjects.teacher": teacherId.toString(),
    })
      .populate("class", "name")
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName");

    // Filter and format teacher's subjects only
    const teacherSchedules = schedules
      .map((schedule) => {
        const teacherSubjects = schedule.subjects
          .filter(
            (item) => item.teacher._id.toString() === teacherId.toString(),
          )
          .sort((a, b) => a.order - b.order);

        return {
          class: schedule.class,
          subjects: teacherSubjects,
          startingOrder: schedule.startingOrder || 1,
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

// Update current topic number for a subject in schedule (Owner only)
const updateCurrentTopic = async (req, res) => {
  try {
    const { id, subjectId } = req.params;
    const { topicNumber } = req.body;

    if (!topicNumber || topicNumber < 1) {
      return res.status(400).json({
        success: false,
        message: "Mavzu raqami kamida 1 bo'lishi kerak",
      });
    }

    // Find schedule
    const schedule = await Schedule.findById(id);
    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Dars jadvali topilmadi",
      });
    }

    // Find subject in schedule
    const subjectIndex = schedule.subjects.findIndex(
      (s) => s.subject.toString() === subjectId,
    );

    if (subjectIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Ushbu sinf jadvalida fan topilmadi",
      });
    }

    // Verify topic exists
    const topic = await Topic.findOne({
      subject: subjectId,
      order: topicNumber,
    });

    if (!topic) {
      return res.status(404).json({
        success: false,
        message: `${topicNumber}-mavzu ushbu fan uchun topilmadi`,
      });
    }

    // Update current topic number
    schedule.subjects[subjectIndex].currentTopicNumber = topicNumber;
    await schedule.save();

    const populatedSchedule = await Schedule.findById(schedule._id)
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName");

    res.json({
      success: true,
      message: "Hozirgi mavzu raqami yangilandi",
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

module.exports = {
  getScheduleByClass,
  getScheduleByDay,
  createOrUpdateSchedule,
  deleteSchedule,
  getMyTodaySchedule,
  getAllTodaySchedules,
  updateCurrentTopic,
  exportScheduleByClass,
};
