const Grade = require("../models/grade.model");
const User = require("../models/user.model");
const Subject = require("../models/subject.model");
const Class = require("../models/class.model");
const Holiday = require("../models/holiday.model");
const { GRADE_EDIT_DAYS_LIMIT } = require("../utils/constants");

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
      query.teacher = req.user.id;
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

    const grades = await Grade.find({
      class: classId,
      date: { $gte: startDate, $lte: endDate },
    })
      .populate("student", "firstName lastName")
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .sort({ "student.lastName": 1, "student.firstName": 1 });

    res.json({
      success: true,
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

// Create grade (Teacher only)
const createGrade = async (req, res) => {
  try {
    const { studentId, subjectId, classId, grade, comment } = req.body;

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

    // Check grade (must be between 2-5)
    if (grade < 2 || grade > 5) {
      return res.status(400).json({
        success: false,
        message: "Baho 2 dan 5 gacha bo'lishi kerak",
      });
    }

    // Validate student, subject and class exist
    const student = await User.findOne({
      _id: studentId,
      role: "student",
      class: classId,
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

    // Skip Sunday (yakshanba) - no lessons
    if (todayDayName === "yakshanba") {
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

    // Check if teacher has this subject in today's schedule
    const hasSubjectToday = todaySchedule.subjects.some(
      (s) =>
        s.subject.toString() === subjectId &&
        s.teacher.toString() === req.user.id
    );

    if (!hasSubjectToday) {
      return res.status(403).json({
        success: false,
        message: `Bugun (${todayDayName}) ushbu sinfda sizning bu fan darslaringiz yo'q`,
      });
    }

    // Date must be today
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const tomorrow = new Date(todayDate);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Check if grade already exists for this student, subject, and date (today)
    const existingGrade = await Grade.findOne({
      student: studentId,
      subject: subjectId,
      date: { $gte: todayDate, $lt: tomorrow },
    });

    if (existingGrade) {
      return res.status(400).json({
        success: false,
        message:
          "Bugun ushbu o'quvchiga bu fan uchun baho allaqachon qo'yilgan",
      });
    }

    // Create grade record with today's date
    const newGrade = await Grade.create({
      student: studentId,
      subject: subjectId,
      class: classId,
      teacher: req.user.id,
      grade,
      date: new Date(),
      comment,
    });

    const populatedGrade = await Grade.findById(newGrade._id)
      .populate("student", "firstName lastName")
      .populate("subject", "name")
      .populate("teacher", "firstName lastName")
      .populate("class", "name");

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
    if (gradeDoc.teacher.toString() !== req.user.id) {
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

    // Add to history
    if (newGrade && newGrade !== gradeDoc.grade) {
      gradeDoc.editHistory.push({
        previousGrade: gradeDoc.grade,
        editedAt: new Date(),
        editedBy: req.user.id,
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

// Delete grade (Owner only)
const deleteGrade = async (req, res) => {
  try {
    const grade = await Grade.findById(req.params.id);

    if (!grade) {
      return res.status(404).json({
        success: false,
        message: "Baho topilmadi",
      });
    }

    await grade.deleteOne();

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
      req.user.role === "student" ? req.user.id : req.params.studentId;
    
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
    const teacherSubjects = [];
    todaySchedule.subjects.forEach((item) => {
      if (item.teacher.toString() === req.user.id) {
        const exists = teacherSubjects.find(
          (s) => s._id.toString() === item.subject._id.toString()
        );
        if (!exists) {
          teacherSubjects.push(item.subject);
        }
      }
    });

    res.json({
      success: true,
      data: teacherSubjects,
      day: todayDayName,
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
    const { classId, subjectId, date } = req.query;

    if (!classId || !subjectId || !date) {
      return res.status(400).json({
        success: false,
        message: "Sinf, fan va sana majburiy",
      });
    }

    // Get all students in the class
    const students = await User.find({ role: "student", class: classId })
      .select("firstName lastName")
      .sort({ lastName: 1, firstName: 1 });

    // Parse date range
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    // Get grades for this class, subject and date
    const grades = await Grade.find({
      class: classId,
      subject: subjectId,
      date: { $gte: startDate, $lte: endDate },
    }).populate("teacher", "firstName lastName");

    // Map grades to students
    const studentsWithGrades = students.map((student) => {
      const grade = grades.find(
        (g) => g.student.toString() === student._id.toString()
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
  getGrades,
  getGradesByClassAndDate,
  createGrade,
  updateGrade,
  deleteGrade,
  getStudentGrades,
  getTeacherSubjectsInClass,
  getStudentsWithGrades,
};
