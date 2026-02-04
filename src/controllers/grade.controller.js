// Mongoose
const mongoose = require("mongoose");

// Models
const User = require("../models/user.model");
const Grade = require("../models/grade.model");
const Class = require("../models/class.model");
const Subject = require("../models/subject.model");
const Holiday = require("../models/holiday.model");
const Schedule = require("../models/schedule.model");
const Topic = require("../models/topic.model");
const ClassSubjectProgress = require("../models/classSubjectProgress.model");

// Services
const {
  updateWeeklyStatsForGrade,
} = require("../services/weeklystats.service");
const ExcelService = require("../services/excel.service");

const {
  getDayNameUz,
  getDateRangeForDay,
  getCurrentDayUz,
  isSunday,
} = require("../helpers/date.helpers");

// Vaqtni minutlarga aylantirish (HH:MM -> minutes)
const timeToMinutes = (time) => {
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

// Get missing grades for today (Owner only)
const getMissingGradesToday = async (req, res) => {
  try {
    // 1. Yakshanba tekshirish
    if (isSunday()) {
      return res.json({
        success: true,
        data: {
          isHoliday: false,
          isSunday: true,
          message: "Yakshanba kuni dars yo'q",
          byTeacher: [],
          summary: {
            totalTeachers: 0,
            totalLessons: 0,
            totalMissingStudents: 0,
          },
        },
      });
    }

    // 2. Bayram kuni tekshirish
    const holidayCheck = await Holiday.isHoliday(new Date());
    if (holidayCheck.isHoliday) {
      return res.json({
        success: true,
        data: {
          isHoliday: true,
          holiday: holidayCheck.holiday,
          message: `Bugun dam olish kuni: ${holidayCheck.holiday.name}`,
          byTeacher: [],
          summary: {
            totalTeachers: 0,
            totalLessons: 0,
            totalMissingStudents: 0,
          },
        },
      });
    }

    // 3. Bugungi kun nomi va hozirgi vaqt
    const todayDayName = getCurrentDayUz();
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // 4. Bugungi sana oralig'i
    const { startDate, endDate } = getDateRangeForDay(new Date());

    // 5. Bugungi barcha jadvallarni olish
    const todaySchedules = await Schedule.find({ day: todayDayName })
      .populate("class", "name isActive")
      .populate("subjects.subject", "name")
      .populate("subjects.teacher", "firstName lastName");

    // 6. O'qituvchilar bo'yicha guruhlash uchun map
    const teacherDataMap = {};

    for (const schedule of todaySchedules) {
      // Faol bo'lmagan sinflarni o'tkazib yuborish
      if (!schedule.class || !schedule.class.isActive) continue;

      // Sinfdagi barcha faol o'quvchilarni olish
      const studentsInClass = await User.find({
        role: "student",
        classes: schedule.class._id,
        isActive: true,
      }).select("_id firstName lastName");

      if (studentsInClass.length === 0) continue;

      // Bugungi baholarni olish
      const todayGrades = await Grade.find({
        class: schedule.class._id,
        date: { $gte: startDate, $lte: endDate },
      });

      // Har bir darsni tekshirish
      for (const lesson of schedule.subjects) {
        if (!lesson.teacher) continue;

        // Vaqt tekshiruvi: endTime mavjud va o'tib ketgan yoki endTime yo'q
        const endMinutes = timeToMinutes(lesson.endTime);
        const isLessonEnded =
          endMinutes === null || currentMinutes > endMinutes;

        // Agar dars hali tugamagan bo'lsa, o'tkazib yuboramiz
        if (!isLessonEnded) continue;

        // Bu dars uchun baho olgan o'quvchilar
        const gradedStudentIds = new Set(
          todayGrades
            .filter(
              (g) =>
                g.subject.toString() === lesson.subject._id.toString() &&
                g.lessonOrder === lesson.order,
            )
            .map((g) => g.student.toString()),
        );

        // Baho olmagan o'quvchilar
        const missingStudents = studentsInClass.filter(
          (s) => !gradedStudentIds.has(s._id.toString()),
        );

        // Agar baho olmagan o'quvchilar bo'lsa
        if (missingStudents.length > 0) {
          const teacherId = lesson.teacher._id.toString();

          // O'qituvchi uchun data yaratish
          if (!teacherDataMap[teacherId]) {
            teacherDataMap[teacherId] = {
              teacher: {
                _id: lesson.teacher._id,
                firstName: lesson.teacher.firstName,
                lastName: lesson.teacher.lastName,
              },
              lessons: [],
            };
          }

          // Dars ma'lumotlarini qo'shish
          teacherDataMap[teacherId].lessons.push({
            class: {
              _id: schedule.class._id,
              name: schedule.class.name,
            },
            subject: {
              _id: lesson.subject._id,
              name: lesson.subject.name,
            },
            lessonOrder: lesson.order,
            startTime: lesson.startTime,
            endTime: lesson.endTime,
            totalStudents: studentsInClass.length,
            missingStudents: missingStudents.map((s) => ({
              _id: s._id,
              firstName: s.firstName,
              lastName: s.lastName,
            })),
          });
        }
      }
    }

    // 7. Array formatiga o'tkazish
    const byTeacher = Object.values(teacherDataMap);

    // 8. Summary hisoblash
    let totalLessons = 0;
    let totalMissingStudents = 0;
    byTeacher.forEach((t) => {
      totalLessons += t.lessons.length;
      t.lessons.forEach((l) => {
        totalMissingStudents += l.missingStudents.length;
      });
    });

    // 9. Response
    return res.json({
      success: true,
      data: {
        isHoliday: false,
        isSunday: false,
        dayName: todayDayName,
        date: new Date().toISOString().split("T")[0],
        byTeacher,
        summary: {
          totalTeachers: byTeacher.length,
          totalLessons,
          totalMissingStudents,
        },
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

// Get grades (with filters)
const getGrades = async (req, res) => {
  try {
    const { studentId, subjectId, classId, startDate, endDate } = req.query;

    let query = {};

    if (studentId) query.student = studentId;
    if (subjectId) query.subject = subjectId;
    if (classId) query.class = classId;

    // If teacher, can only see their own grades
    if (req.user.role === "teacher") {
      query.teacher = req.user._id;
    }

    // Date range
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const grades = await Grade.find(query)
      .populate("student", "firstName lastName")
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .populate("class", "name")
      .sort({ date: -1, createdAt: -1 });

    res.json({
      success: true,
      count: grades.length,
      data: grades,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get grades by class and date
const getGradesByClassAndDate = async (req, res) => {
  try {
    const { classId, date } = req.params;

    // Split date into start and end times
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    // Convert classId to ObjectId if it's a string
    let classObjectId;
    try {
      classObjectId = mongoose.Types.ObjectId.isValid(classId)
        ? new mongoose.Types.ObjectId(classId)
        : classId;
    } catch (error) {
      classObjectId = classId;
    }

    const todayDayName = getDayNameUz(date);

    const todaySchedule = await Schedule.findOne({
      class: classObjectId,
      day: todayDayName,
    });

    // Create a map of subject ID to order
    const subjectOrderMap = {};
    if (todaySchedule && todaySchedule.subjects) {
      todaySchedule.subjects.forEach((s) => {
        const subjectId = s.subject.toString();
        if (!subjectOrderMap[subjectId]) {
          subjectOrderMap[subjectId] = s.order;
        }
      });
    }

    // Get all students in the class
    const allStudents = await User.find({
      role: "student",
      classes: classObjectId,
    })
      .select("_id firstName lastName")
      .sort({ lastName: 1, firstName: 1 });

    // Use aggregation pipeline to get grades
    const grades = await Grade.aggregate([
      {
        $match: {
          class: classObjectId,
          date: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "student",
          foreignField: "_id",
          as: "student",
        },
      },
      { $unwind: "$student" },
      {
        $lookup: {
          from: "subjects",
          localField: "subject",
          foreignField: "_id",
          as: "subject",
        },
      },
      { $unwind: "$subject" },
      {
        $lookup: {
          from: "users",
          localField: "teacher",
          foreignField: "_id",
          as: "teacher",
        },
      },
      { $unwind: "$teacher" },
      {
        $project: {
          _id: 1,
          grade: 1,
          comment: 1,
          date: 1,
          lessonOrder: 1,
          isEdited: 1,
          createdAt: 1,
          "student._id": 1,
          "student.firstName": 1,
          "student.lastName": 1,
          "subject._id": 1,
          "subject.name": 1,
          "teacher._id": 1,
          "teacher.firstName": 1,
          "teacher.lastName": 1,
        },
      },
    ]);

    // Group grades by student
    const gradesByStudent = {};
    grades.forEach((grade) => {
      const studentId = grade.student._id.toString();
      if (!gradesByStudent[studentId]) {
        gradesByStudent[studentId] = {
          student: grade.student,
          grades: [],
        };
      }
      gradesByStudent[studentId].grades.push(grade);
    });

    // Add students without grades
    allStudents.forEach((student) => {
      const studentId = student._id.toString();
      if (!gradesByStudent[studentId]) {
        gradesByStudent[studentId] = {
          student: {
            _id: student._id,
            firstName: student.firstName,
            lastName: student.lastName,
          },
          grades: [],
        };
      }
    });

    // Convert to array and sort by student name
    const studentsWithGrades = Object.values(gradesByStudent).sort((a, b) => {
      const nameA = `${a.student.lastName} ${a.student.firstName}`;
      const nameB = `${b.student.lastName} ${b.student.firstName}`;
      return nameA.localeCompare(nameB);
    });

    res.json({
      success: true,
      data: studentsWithGrades,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Create grade (Teacher only)
const createGrade = async (req, res) => {
  try {
    const { studentId, subjectId, classId, grade, comment, lessonOrder } =
      req.body;

    // Validation
    if (!studentId || !subjectId || !classId || !grade) {
      return res.status(400).json({
        success: false,
        message: "Barcha majburiy maydonlarni to'ldiring",
      });
    }

    // Holiday check
    const holidayCheck = await Holiday.isHoliday(new Date());
    if (holidayCheck.isHoliday) {
      return res.status(403).json({
        success: false,
        message: `Bugun dam olish kuni: ${holidayCheck.holiday.name}. Baho qo'yish mumkin emas.`,
      });
    }

    // Only teacher can add grades
    if (req.user.role !== "teacher") {
      return res.status(403).json({
        success: false,
        message: "Faqat o'qituvchilar baho qo'ya oladi",
      });
    }

    // Check grade (must be between 1-5)
    if (grade < 1 || grade > 5) {
      return res.status(400).json({
        success: false,
        message: "Baho 1 dan 5 gacha bo'lishi kerak",
      });
    }

    // Validate student, subject and class exist
    const student = await User.findOne({
      _id: studentId,
      role: "student",
      classes: classId,
    });
    if (!student) {
      return res.status(404).json({
        success: false,
        message: "O'quvchi ushbu sinfda topilmadi",
      });
    }

    const subject = await Subject.findById(subjectId);
    if (!subject) {
      return res.status(404).json({
        success: false,
        message: "Fan topilmadi",
      });
    }

    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    // Check if teacher teaches this subject in this class TODAY
    const todayDayName = getCurrentDayUz();

    // Skip Sunday (yakshanba) - no lessons
    if (isSunday()) {
      return res.status(403).json({
        success: false,
        message: "Yakshanba kuni dars yo'q, baho qo'yib bo'lmaydi",
      });
    }

    // Find today's schedule for this class
    const todaySchedule = await Schedule.findOne({
      class: classId,
      day: todayDayName,
    });

    if (!todaySchedule) {
      return res.status(403).json({
        success: false,
        message: `Bugun (${todayDayName}) ushbu sinfda dars jadvali topilmadi`,
      });
    }

    // Check if teacher has this subject in today's schedule and validate lessonOrder
    const teacherLessons = todaySchedule.subjects.filter(
      (s) =>
        s.subject.toString() === subjectId &&
        s.teacher.toString() === req.user._id.toString(),
    );

    if (teacherLessons.length === 0) {
      return res.status(403).json({
        success: false,
        message: `Bugun (${todayDayName}) ushbu sinfda sizning bu fan darslaringiz yo'q`,
      });
    }

    // Validate lessonOrder if provided
    const finalLessonOrder = lessonOrder || teacherLessons[0].order;
    const lessonExists = teacherLessons.find(
      (l) => l.order === finalLessonOrder,
    );

    if (!lessonExists) {
      return res.status(400).json({
        success: false,
        message: `Dars tartibi noto'g'ri. Sizning darslaringiz: ${teacherLessons.map((l) => l.order).join(", ")}`,
      });
    }

    // Check grading time window (only if enabled in config)
    const {
      GRADE_TIME_LIMIT_MINUTES,
      ENABLE_SCHEDULE_TIME_VALIDATION,
    } = require("../utils/constants");

    if (ENABLE_SCHEDULE_TIME_VALIDATION) {
      const { checkGradingTimeWindow } = require("../helpers/date.helpers");

      const lessonSchedule = todaySchedule.subjects.find(
        (s) => s.order === finalLessonOrder,
      );

      if (
        !lessonSchedule ||
        !lessonSchedule.startTime ||
        !lessonSchedule.endTime
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Dars jadvali to'liq emas - boshlanish va tugash vaqti kiritilmagan",
        });
      }

      const timeCheck = checkGradingTimeWindow(
        lessonSchedule.startTime,
        lessonSchedule.endTime,
        GRADE_TIME_LIMIT_MINUTES,
      );

      if (!timeCheck.canGrade) {
        return res.status(403).json({
          success: false,
          message: timeCheck.reason,
        });
      }
    }

    // Date must be today
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const tomorrow = new Date(todayDate);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Check if grade already exists for this student, subject, lessonOrder, and date (today)
    const existingGrade = await Grade.findOne({
      student: studentId,
      subject: subjectId,
      lessonOrder: finalLessonOrder,
      date: { $gte: todayDate, $lt: tomorrow },
    });

    if (existingGrade) {
      return res.status(400).json({
        success: false,
        message:
          "Bugun ushbu o'quvchiga bu dars uchun baho allaqachon qo'yilgan",
      });
    }

    // Create grade record with today's date
    const newGrade = await Grade.create({
      student: studentId,
      subject: subjectId,
      class: classId,
      teacher: req.user._id,
      grade,
      date: new Date(),
      lessonOrder: finalLessonOrder,
      comment,
    });

    const populatedGrade = await Grade.findById(newGrade._id)
      .populate("student", "firstName lastName")
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .populate("class", "name");

    // Update WeeklyStats after creating grade
    try {
      await updateWeeklyStatsForGrade(newGrade);
    } catch (statsError) {
      console.error("Error updating WeeklyStats:", statsError);
      // Don't fail the request if stats update fails
    }

    res.status(201).json({
      success: true,
      message: "Baho muvaffaqiyatli qo'yildi",
      data: populatedGrade,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Update grade (Teacher only - only for today's grades)
const updateGrade = async (req, res) => {
  try {
    const { grade: newGrade, comment } = req.body;
    const gradeId = req.params.id;

    const gradeDoc = await Grade.findById(gradeId);

    if (!gradeDoc) {
      return res.status(404).json({
        success: false,
        message: "Baho topilmadi",
      });
    }

    // Only teacher can edit
    if (req.user.role !== "teacher") {
      return res.status(403).json({
        success: false,
        message: "Faqat o'qituvchi baho tahrirlashi mumkin",
      });
    }

    // Can only edit own grades
    if (gradeDoc.teacher.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Bu bahoni tahrirlash uchun ruxsatingiz yo'q",
      });
    }

    // Can only edit today's grades
    const gradeDate = new Date(gradeDoc.date);
    gradeDate.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (gradeDate.getTime() !== today.getTime()) {
      return res.status(403).json({
        success: false,
        message: "Faqat bugungi baholarni tahrirlash mumkin",
      });
    }

    // Check grading time window for updates (only if enabled in config)
    const { ENABLE_SCHEDULE_TIME_VALIDATION } = require("../utils/constants");

    if (ENABLE_SCHEDULE_TIME_VALIDATION) {
      const { getCurrentDayUz } = require("../helpers/date.helpers");
      const Schedule = require("../models/schedule.model");

      const dayName = getCurrentDayUz();
      const todaySchedule = await Schedule.findOne({
        class: gradeDoc.class,
        day: dayName,
      });

      if (!todaySchedule) {
        return res.status(403).json({
          success: false,
          message: "Bugun uchun dars jadvali topilmadi",
        });
      }

      const lessonSchedule = todaySchedule.subjects.find(
        (s) =>
          s.subject.toString() === gradeDoc.subject.toString() &&
          s.order === gradeDoc.lessonOrder,
      );

      if (
        !lessonSchedule ||
        !lessonSchedule.startTime ||
        !lessonSchedule.endTime
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Dars jadvali to'liq emas - boshlanish va tugash vaqti kiritilmagan",
        });
      }

      const { checkGradingTimeWindow } = require("../helpers/date.helpers");
      const { GRADE_TIME_LIMIT_MINUTES } = require("../utils/constants");

      const timeCheck = checkGradingTimeWindow(
        lessonSchedule.startTime,
        lessonSchedule.endTime,
        GRADE_TIME_LIMIT_MINUTES,
      );

      if (!timeCheck.canGrade) {
        return res.status(403).json({
          success: false,
          message: timeCheck.reason,
        });
      }
    }

    // Add to history
    if (newGrade && newGrade !== gradeDoc.grade) {
      gradeDoc.editHistory.push({
        previousGrade: gradeDoc.grade,
        editedAt: new Date(),
        editedBy: req.user._id,
      });
      gradeDoc.grade = newGrade;
      gradeDoc.isEdited = true;
    }

    if (comment !== undefined) {
      gradeDoc.comment = comment;
    }

    await gradeDoc.save();

    const updatedGrade = await Grade.findById(gradeDoc._id)
      .populate("student", "firstName lastName")
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .populate("class", "name")
      .populate("editHistory.editedBy", "firstName lastName");

    // Update WeeklyStats after updating grade
    try {
      await updateWeeklyStatsForGrade(gradeDoc);
    } catch (statsError) {
      console.error("Error updating WeeklyStats:", statsError);
      // Don't fail the request if stats update fails
    }

    res.json({
      success: true,
      message: "Baho muvaffaqiyatli yangilandi",
      data: updatedGrade,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Delete grade (Teacher can delete own today's grades, Owner can delete any)
const deleteGrade = async (req, res) => {
  try {
    const grade = await Grade.findById(req.params.id);

    if (!grade) {
      return res.status(404).json({
        success: false,
        message: "Baho topilmadi",
      });
    }

    // If teacher role, apply restrictions
    if (req.user.role === "teacher") {
      // Can only delete own grades
      if (grade.teacher.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Bu bahoni o'chirish uchun ruxsatingiz yo'q",
        });
      }

      // Can only delete today's grades
      const gradeDate = new Date(grade.date);
      gradeDate.setHours(0, 0, 0, 0);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (gradeDate.getTime() !== today.getTime()) {
        return res.status(403).json({
          success: false,
          message: "Faqat bugungi baholarni o'chirish mumkin",
        });
      }
    }

    // Save grade data before deleting (for WeeklyStats update)
    const gradeData = {
      student: grade.student,
      subject: grade.subject,
      class: grade.class,
      teacher: grade.teacher,
      grade: grade.grade,
      date: grade.date,
      lessonOrder: grade.lessonOrder,
    };

    // Delete the grade
    await Grade.findByIdAndDelete(req.params.id);

    // Update WeeklyStats after deleting grade
    try {
      await updateWeeklyStatsForGrade(gradeData);
    } catch (statsError) {
      console.error("Error updating WeeklyStats:", statsError);
      // Don't fail the request if stats update fails
    }

    res.json({
      success: true,
      message: "Baho muvaffaqiyatli o'chirildi",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get student grades
const getStudentGrades = async (req, res) => {
  try {
    const studentId =
      req.user.role === "student" ? req.user._id : req.params.studentId;

    // Get date from query parameter (for student) or use all dates
    const { date } = req.query;

    let query = { student: studentId };

    // If date is provided, filter by that specific date
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);

      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      query.date = { $gte: startDate, $lte: endDate };
    }

    const grades = await Grade.find(query)
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .populate("class", "name")
      .sort({ date: -1 });

    // Statistics by subject
    const statsBySubject = {};
    grades.forEach((g) => {
      const subjectName = g.subject.name;
      if (!statsBySubject[subjectName]) {
        statsBySubject[subjectName] = {
          subject: g.subject,
          grades: [],
          average: 0,
          count: 0,
        };
      }
      statsBySubject[subjectName].grades.push(g.grade);
      statsBySubject[subjectName].count++;
    });

    // Calculate average
    Object.keys(statsBySubject).forEach((subjectName) => {
      const stats = statsBySubject[subjectName];
      stats.average = (
        stats.grades.reduce((a, b) => a + b, 0) / stats.count
      ).toFixed(2);
    });

    res.json({
      success: true,
      data: {
        grades,
        statistics: statsBySubject,
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

// Get teacher's subjects in a class (for grade adding - TODAY's schedule only)
const getTeacherSubjectsInClass = async (req, res) => {
  try {
    const { classId } = req.params;

    if (req.user.role !== "teacher") {
      return res.status(403).json({
        success: false,
        message: "Faqat o'qituvchilar uchun",
      });
    }

    const Schedule = require("../models/schedule.model");

    // Get today's day name in Uzbek
    const daysUz = [
      "yakshanba",
      "dushanba",
      "seshanba",
      "chorshanba",
      "payshanba",
      "juma",
      "shanba",
    ];
    const today = new Date();
    const todayDayName = daysUz[today.getDay()];

    // If Sunday, return empty array
    if (todayDayName === "yakshanba") {
      return res.json({
        success: true,
        data: [],
        message: "Yakshanba kuni dars yo'q",
      });
    }

    // Find today's schedule for this class
    const todaySchedule = await Schedule.findOne({
      class: classId,
      day: todayDayName,
    }).populate("subjects.subject", "name");

    if (!todaySchedule) {
      return res.json({
        success: true,
        data: [],
        message: `Bugun (${todayDayName}) ushbu sinfda dars jadvali yo'q`,
      });
    }

    // Filter only teacher's subjects from today's schedule
    // Include ALL lessons (with duplicates) and add order/lessonNumber
    const teacherSubjects = [];
    const subjectCountMap = {}; // Track how many times each subject appears
    const startingOrder = todaySchedule.startingOrder || 1;

    // Get unique subject IDs for progress lookup
    const teacherSubjectIds = new Set();
    todaySchedule.subjects.forEach((item) => {
      if (item.teacher.toString() === req.user._id.toString()) {
        teacherSubjectIds.add(item.subject._id.toString());
      }
    });

    // Get progress for all teacher's subjects in this class
    const progressList = await ClassSubjectProgress.find({
      class: classId,
      subject: { $in: Array.from(teacherSubjectIds) },
    }).lean();

    // Create progress map
    const progressMap = new Map();
    for (const p of progressList) {
      progressMap.set(p.subject.toString(), p.currentTopicNumber);
    }

    todaySchedule.subjects.forEach((item) => {
      if (item.teacher.toString() === req.user._id.toString()) {
        const subjectId = item.subject._id.toString();

        // Increment count for this subject
        if (!subjectCountMap[subjectId]) {
          subjectCountMap[subjectId] = 0;
        }
        subjectCountMap[subjectId]++;

        // Add subject with lesson number
        teacherSubjects.push({
          _id: item.subject._id,
          name: item.subject.name,
          order: item.order,
          startingOrder: startingOrder,
          lessonNumber: subjectCountMap[subjectId], // 1st, 2nd, 3rd occurrence
          currentTopicNumber: progressMap.get(subjectId) || 1,
        });
      }
    });

    // Sort by order to maintain schedule sequence
    teacherSubjects.sort((a, b) => a.order - b.order);

    res.json({
      success: true,
      data: teacherSubjects,
      day: todayDayName,
      startingOrder: startingOrder,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Get students with their grades for a class, subject and date
const getStudentsWithGrades = async (req, res) => {
  try {
    const { classId, subjectId, date, lessonOrder } = req.query;

    if (!classId || !subjectId || !date) {
      return res.status(400).json({
        success: false,
        message: "Sinf, fan va sana majburiy",
      });
    }

    const finalLessonOrder = lessonOrder ? parseInt(lessonOrder) : null;

    // Get all students in the class
    const students = await User.find({ role: "student", classes: classId })
      .select("firstName lastName")
      .sort({ lastName: 1, firstName: 1 });

    // Parse date range
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    // Get grades for this class, subject and date
    const gradeQuery = {
      class: classId,
      subject: subjectId,
      date: { $gte: startDate, $lte: endDate },
    };

    // If lessonOrder is specified, filter by it
    if (finalLessonOrder) {
      gradeQuery.lessonOrder = finalLessonOrder;
    }

    const grades = await Grade.find(gradeQuery).populate(
      "teacher",
      "firstName lastName",
    );

    // Get current topic for this class and subject from ClassSubjectProgress
    let currentTopic = null;
    const progress = await ClassSubjectProgress.findOne({
      class: classId,
      subject: subjectId,
    });

    const currentTopicNumber = progress?.currentTopicNumber || 1;

    const topic = await Topic.findOne({
      subject: subjectId,
      order: currentTopicNumber,
    }).select("order name description");

    if (topic) {
      currentTopic = {
        number: topic.order,
        name: topic.name,
        description: topic.description || "",
      };
    }

    // Map grades to students
    const studentsWithGrades = students.map((student) => {
      const grade = grades.find(
        (g) => g.student.toString() === student._id.toString(),
      );
      return {
        _id: student._id,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: grade || null,
      };
    });

    res.json({
      success: true,
      data: studentsWithGrades,
      currentTopic,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server xatosi",
      error: error.message,
    });
  }
};

// Export grades to Excel
const exportGrades = async (req, res) => {
  try {
    const { classId, date, subjectId } = req.query;

    if (!classId || !date) {
      return res.status(400).json({
        success: false,
        message: "Sinf va sana majburiy",
      });
    }

    // Get class info
    const classData = await Class.findById(classId);
    if (!classData) {
      return res.status(404).json({
        success: false,
        message: "Sinf topilmadi",
      });
    }

    // Split date into start and end times
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const classObjectId = mongoose.Types.ObjectId.isValid(classId)
      ? new mongoose.Types.ObjectId(classId)
      : classId;

    const todayDayName = getDayNameUz(date);

    // Get schedule for the day
    const todaySchedule = await Schedule.findOne({
      class: classObjectId,
      day: todayDayName,
    }).populate("subjects.subject", "name");

    // Get all students in the class
    const allStudents = await User.find({
      role: "student",
      classes: classObjectId,
    })
      .select("_id firstName lastName")
      .sort({ firstName: 1, lastName: 1 });

    // Get grades with all necessary fields
    const grades = await Grade.find({
      class: classObjectId,
      date: { $gte: startDate, $lte: endDate },
    })
      .populate("student", "firstName lastName")
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .lean();

    // Create map of student grades
    const studentGradesMap = {};
    allStudents.forEach((student) => {
      studentGradesMap[student._id.toString()] = {
        student,
        grades: grades.filter(
          (g) =>
            g.student &&
            g.student._id &&
            g.student._id.toString() === student._id.toString(),
        ),
      };
    });

    const studentsWithGrades = Object.values(studentGradesMap);

    let columns, data, sheetName;

    // If specific subject selected
    if (subjectId && subjectId !== "all") {
      const subject = await Subject.findById(subjectId);
      sheetName = `${classData.name} - ${subject?.name || "Fan"}`;

      columns = [
        { header: "O'quvchi", key: "student", width: 30 },
        { header: "Baho", key: "grade", width: 12 },
        { header: "O'qituvchi", key: "teacher", width: 25 },
      ];

      data = studentsWithGrades.map((item) => {
        const gradeData = item.grades.find(
          (g) =>
            g.subject &&
            g.subject._id &&
            g.subject._id.toString() === subjectId,
        );

        return {
          student:
            `${item.student.firstName} ${item.student.lastName || ""}`.trim(),
          grade: gradeData ? gradeData.grade : "-",
          teacher: gradeData
            ? `${gradeData.teacher.firstName} ${gradeData.teacher.lastName || ""}`.trim()
            : "-",
        };
      });
    } else {
      // All subjects
      sheetName = `${classData.name} - Barcha fanlar`;

      const todaySubjects = todaySchedule?.subjects || [];
      const sortedSubjects = todaySubjects
        .filter((s) => s.subject)
        .sort((a, b) => a.order - b.order);

      columns = [{ header: "O'quvchi", key: "student", width: 30 }];

      // Add columns for each subject
      sortedSubjects.forEach((s, idx) => {
        columns.push({
          header: `${idx + 1}. ${s.subject.name}`,
          key: `subject_${s.order}`,
          width: 15,
        });
      });

      columns.push({ header: "O'rtacha", key: "average", width: 12 });

      data = studentsWithGrades.map((item) => {
        const row = {
          student:
            `${item.student.firstName} ${item.student.lastName || ""}`.trim(),
        };

        let totalGrades = 0;
        let gradeCount = 0;

        // Fan takrorlanish indekslarini hisoblash
        const subjectOccurrences = {};

        // Shu o'quvchining baholarini lessonOrder bo'yicha tartiblash
        const sortedGrades = [...item.grades].sort(
          (a, b) => (a.lessonOrder || 0) - (b.lessonOrder || 0),
        );

        // Har bir fan uchun baholarni guruhlash
        const gradesBySubject = {};
        sortedGrades.forEach((g) => {
          if (g.subject && g.subject._id) {
            const subjectId = g.subject._id.toString();
            if (!gradesBySubject[subjectId]) {
              gradesBySubject[subjectId] = [];
            }
            gradesBySubject[subjectId].push(g);
          }
        });

        sortedSubjects.forEach((s) => {
          const subjectId = s.subject._id.toString();

          // Bu fanning nechanchi marta takrorlanishini hisoblash
          if (!subjectOccurrences[subjectId]) {
            subjectOccurrences[subjectId] = 0;
          }
          const occurrenceIndex = subjectOccurrences[subjectId];
          subjectOccurrences[subjectId]++;

          // Shu takrorlanish indeksidagi bahoni olish
          const subjectGrades = gradesBySubject[subjectId] || [];
          const gradeData = subjectGrades[occurrenceIndex] || null;

          const gradeValue = gradeData ? gradeData.grade : "-";
          row[`subject_${s.order}`] = gradeValue;

          if (gradeData && typeof gradeData.grade === "number") {
            totalGrades += gradeData.grade;
            gradeCount++;
          }
        });

        row.average =
          gradeCount > 0 ? (totalGrades / gradeCount).toFixed(2) : "-";

        return row;
      });
    }

    // Create Excel
    const workbook = ExcelService.createExcel({
      sheetName,
      columns,
      data,
    });

    // Generate filename
    const filename = ExcelService.generateFileName(
      `${classData.name}_baholar_${date}`,
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

module.exports = {
  getGrades,
  getMissingGradesToday,
  createGrade,
  updateGrade,
  deleteGrade,
  getStudentGrades,
  getStudentsWithGrades,
  getGradesByClassAndDate,
  getTeacherSubjectsInClass,
  exportGrades,
};
