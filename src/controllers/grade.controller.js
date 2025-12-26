const Grade = require('../models/grade.model');
const User = require('../models/user.model');
const Subject = require('../models/subject.model');
const Class = require('../models/class.model');
const { GRADE_EDIT_DAYS_LIMIT } = require('../utils/constants');

// Get grades (with filters)
exports.getGrades = async (req, res) => {
  try {
    const { studentId, subjectId, classId, startDate, endDate } = req.query;
    
    let query = {};
    
    if (studentId) query.student = studentId;
    if (subjectId) query.subject = subjectId;
    if (classId) query.class = classId;
    
    // If teacher, can only see their own grades
    if (req.user.role === 'teacher') {
      query.teacher = req.user.id;
      
      // Teacher can only see grades from their assigned classes
      const teacher = await User.findById(req.user.id);
      if (classId && !teacher.assignedClasses.includes(classId)) {
        return res.status(403).json({
          success: false,
          message: 'Bu sinfga ruxsatingiz yo\'q'
        });
      }
    }

    // Date range
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const grades = await Grade.find(query)
      .populate('student', 'firstName lastName')
      .populate('subject', 'name')
      .populate('teacher', 'firstName lastName')
      .populate('class', 'name grade section')
      .sort({ date: -1, createdAt: -1 });

    res.json({
      success: true,
      count: grades.length,
      data: grades
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
    });
  }
};

// Get grades by class and date
exports.getGradesByClassAndDate = async (req, res) => {
  try {
    const { classId, date } = req.params;

    // Split date into start and end times
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const grades = await Grade.find({
      class: classId,
      date: { $gte: startDate, $lte: endDate }
    })
      .populate('student', 'firstName lastName')
      .populate('subject', 'name')
      .populate('teacher', 'firstName lastName')
      .sort({ 'student.lastName': 1, 'student.firstName': 1 });

    res.json({
      success: true,
      data: grades
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
    });
  }
};

// Create grade (Teacher)
exports.createGrade = async (req, res) => {
  try {
    const { studentId, subjectId, classId, grade, date, comment } = req.body;

    // Validation
    if (!studentId || !subjectId || !classId || !grade) {
      return res.status(400).json({
        success: false,
        message: 'Barcha majburiy maydonlarni to\'ldiring'
      });
    }

    // Check grade (must be between 2-5)
    if (grade < 2 || grade > 5) {
      return res.status(400).json({
        success: false,
        message: 'Baho 2 dan 5 gacha bo\'lishi kerak'
      });
    }

    // Check if teacher is assigned to this class
    if (req.user.role === 'teacher') {
      const teacher = await User.findById(req.user.id);
      if (!teacher.assignedClasses.includes(classId)) {
        return res.status(403).json({
          success: false,
          message: 'Bu sinfga ruxsatingiz yo\'q'
        });
      }
    }

    // Validate student, subject and class exist
    const student = await User.findOne({ _id: studentId, role: 'student', class: classId });
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'O\'quvchi ushbu sinfda topilmadi'
      });
    }

    const subject = await Subject.findById(subjectId);
    if (!subject) {
      return res.status(404).json({
        success: false,
        message: 'Fan topilmadi'
      });
    }

    const classExists = await Class.findById(classId);
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: 'Sinf topilmadi'
      });
    }

    // Create grade record
    const newGrade = await Grade.create({
      student: studentId,
      subject: subjectId,
      class: classId,
      teacher: req.user.id,
      grade,
      date: date || new Date(),
      comment
    });

    const populatedGrade = await Grade.findById(newGrade._id)
      .populate('student', 'firstName lastName')
      .populate('subject', 'name')
      .populate('teacher', 'firstName lastName')
      .populate('class', 'name grade section');

    res.status(201).json({
      success: true,
      message: 'Baho muvaffaqiyatli qo\'yildi',
      data: populatedGrade
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
    });
  }
};

// Update grade (Teacher - only within 2 days)
exports.updateGrade = async (req, res) => {
  try {
    const { grade: newGrade, comment } = req.body;
    const gradeId = req.params.id;

    const gradeDoc = await Grade.findById(gradeId);

    if (!gradeDoc) {
      return res.status(404).json({
        success: false,
        message: 'Baho topilmadi'
      });
    }

    // Can only edit own grades
    if (req.user.role === 'teacher' && gradeDoc.teacher.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Bu bahoni tahrirlash uchun ruxsatingiz yo\'q'
      });
    }

    // Calculate days since grade was given
    const gradeDate = new Date(gradeDoc.date);
    const currentDate = new Date();
    const daysDifference = Math.floor((currentDate - gradeDate) / (1000 * 60 * 60 * 24));

    // If more than GRADE_EDIT_DAYS_LIMIT days, cannot edit
    if (daysDifference > GRADE_EDIT_DAYS_LIMIT) {
      return res.status(403).json({
        success: false,
        message: `Baho qo'yilganiga ${daysDifference} kun bo'ldi. Faqat ${GRADE_EDIT_DAYS_LIMIT} kun ichida tahrirlash mumkin`
      });
    }

    // Add to history
    if (newGrade && newGrade !== gradeDoc.grade) {
      gradeDoc.editHistory.push({
        previousGrade: gradeDoc.grade,
        editedAt: new Date(),
        editedBy: req.user.id
      });
      gradeDoc.grade = newGrade;
      gradeDoc.isEdited = true;
    }

    if (comment !== undefined) {
      gradeDoc.comment = comment;
    }

    await gradeDoc.save();

    const updatedGrade = await Grade.findById(gradeDoc._id)
      .populate('student', 'firstName lastName')
      .populate('subject', 'name')
      .populate('teacher', 'firstName lastName')
      .populate('class', 'name grade section')
      .populate('editHistory.editedBy', 'firstName lastName');

    res.json({
      success: true,
      message: 'Baho muvaffaqiyatli yangilandi',
      data: updatedGrade
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
    });
  }
};

// Delete grade (Owner only)
exports.deleteGrade = async (req, res) => {
  try {
    const grade = await Grade.findById(req.params.id);

    if (!grade) {
      return res.status(404).json({
        success: false,
        message: 'Baho topilmadi'
      });
    }

    await grade.deleteOne();

    res.json({
      success: true,
      message: 'Baho muvaffaqiyatli o\'chirildi'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
    });
  }
};

// Get student grades
exports.getStudentGrades = async (req, res) => {
  try {
    const studentId = req.user.role === 'student' ? req.user.id : req.params.studentId;

    const grades = await Grade.find({ student: studentId })
      .populate('subject', 'name')
      .populate('teacher', 'firstName lastName')
      .populate('class', 'name grade section')
      .sort({ date: -1 });

    // Statistics by subject
    const statsBySubject = {};
    grades.forEach(g => {
      const subjectName = g.subject.name;
      if (!statsBySubject[subjectName]) {
        statsBySubject[subjectName] = {
          subject: g.subject,
          grades: [],
          average: 0,
          count: 0
        };
      }
      statsBySubject[subjectName].grades.push(g.grade);
      statsBySubject[subjectName].count++;
    });

    // O'rtachani hisoblash
    Object.keys(statsBySubject).forEach(subjectName => {
      const stats = statsBySubject[subjectName];
      stats.average = (stats.grades.reduce((a, b) => a + b, 0) / stats.count).toFixed(2);
    });

    res.json({
      success: true,
      data: {
        grades,
        statistics: statsBySubject
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server xatosi',
      error: error.message
    });
  }
};
