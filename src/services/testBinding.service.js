const TestBinding = require("../models/testBinding.model");
const Test = require("../models/test.model");
const TestSeason = require("../models/testSeason.model");
const TestSession = require("../models/testSession.model");
const Question = require("../models/question.model");
const Subject = require("../models/subject.model");
const User = require("../models/user.model");
const TeacherAssignment = require("../models/teacherAssignment.model");
const { assertTeacherAssigned } = require("./teacherAssignment.service");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

/**
 * Test muallifligini va biriktiruv ownership ni tekshiradi.
 */
async function _loadBindingOwned(bindingId, teacherId) {
  const binding = await TestBinding.findById(bindingId);
  if (!binding || !binding.isActive) {
    throw new NotFoundError("Biriktiruv topilmadi");
  }
  if (binding.teacher.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu biriktiruv sizga tegishli emas");
  }
  return binding;
}

async function _loadTestOwned(testId, teacherId) {
  const test = await Test.findById(testId);
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacher.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }
  return test;
}

/**
 * Testning barcha biriktiruvlarini oladi (populate qilingan).
 */
async function listBindingsForTest(testId, teacherId) {
  await _loadTestOwned(testId, teacherId);
  return TestBinding.find({ test: testId, isActive: true })
    .populate("season", "name status startDate endDate")
    .populate("subject", "name")
    .populate("classes", "name")
    .sort({ createdAt: -1 });
}

/**
 * Yangi biriktiruv yaratadi.
 */
async function createBinding(testId, data, teacherId) {
  const test = await _loadTestOwned(testId, teacherId);
  const { season, subject, classes } = data;

  if (!season || !subject) {
    throw new BadRequestError("Mavsum va fan majburiy");
  }

  const [seasonDoc, subjectDoc] = await Promise.all([
    TestSeason.findById(season),
    Subject.findById(subject),
  ]);
  if (!seasonDoc) throw new NotFoundError("Mavsum topilmadi");
  if (!subjectDoc) throw new NotFoundError("Fan topilmadi");

  const classIds = Array.isArray(classes) ? classes : [];

  // Har sinf uchun biriktirilganligi tekshiriladi
  for (const classId of classIds) {
    await assertTeacherAssigned(teacherId, season, classId, subject);
  }

  // Agar sinflar berilmagan bo'lsa, kamida o'qituvchining shu mavsum+fan
  // bo'yicha biror sinfi borligini tekshirish (umuman biriktiriluvchan bo'lishi uchun)
  if (classIds.length === 0) {
    const hasAssignment = await TeacherAssignment.exists({
      season,
      subject,
      teacher: teacherId,
      isActive: true,
    });
    if (!hasAssignment) {
      throw new ForbiddenError(
        "Siz ushbu mavsum va fan bo'yicha hech qaysi sinfga biriktirilmagansiz",
      );
    }
  }

  const binding = await TestBinding.create({
    test: test._id,
    teacher: teacherId,
    season,
    subject,
    classes: classIds,
  });

  return binding;
}

/**
 * Biriktiruvni yangilaydi (sinflar, mavsum, fan).
 */
async function updateBinding(id, data, teacherId) {
  const binding = await _loadBindingOwned(id, teacherId);
  const { season, subject, classes } = data;

  if (season !== undefined) binding.season = season;
  if (subject !== undefined) binding.subject = subject;

  if (classes !== undefined) {
    const classIds = Array.isArray(classes) ? classes : [];
    for (const classId of classIds) {
      await assertTeacherAssigned(
        teacherId,
        binding.season,
        classId,
        binding.subject,
      );
    }
    binding.classes = classIds;
  }

  await binding.save();
  return binding;
}

/**
 * Biriktiruvni o'chiradi. Sessiyalar bo'lsa soft, aks holda hard.
 */
async function deleteBinding(id, teacherId) {
  const binding = await _loadBindingOwned(id, teacherId);

  const sessionCount = await TestSession.countDocuments({ binding: id });
  if (sessionCount > 0) {
    binding.isActive = false;
    binding.status = "closed";
    await binding.save();
    return { deleted: false };
  }

  await TestBinding.findByIdAndDelete(id);
  return { deleted: true };
}

/**
 * O'qituvchi (test muallifi) o'quvchiga qayta urinishga ruxsat beradi.
 */
async function reopenSessionForStudent(bindingId, studentId, teacherId) {
  const binding = await _loadBindingOwned(bindingId, teacherId);

  const student = await User.findById(studentId).select("_id role");
  if (!student || student.role !== "student") {
    throw new NotFoundError("O'quvchi topilmadi");
  }

  const inProgress = await TestSession.findOne({
    binding: bindingId,
    student: studentId,
    status: "in_progress",
  });
  if (inProgress) {
    throw new BadRequestError(
      "O'quvchining davom etayotgan sessiyasi bor, avval u yakunlanishi kerak",
    );
  }

  const finishedCount = await TestSession.countDocuments({
    binding: bindingId,
    student: studentId,
  });
  if (finishedCount === 0) {
    throw new BadRequestError(
      "O'quvchi bu biriktiruvni hali boshlamagan, qayta urinish ruxsati shart emas",
    );
  }

  binding.reopenGrants.push({
    student: studentId,
    grantedBy: teacherId,
    grantedAt: new Date(),
  });
  await binding.save();

  return { binding };
}

/**
 * O'quvchi topshira oladigan biriktiruvlarni qaytaradi.
 * student.classes ∩ binding.classes, test savollari yetarli, mavsum faol va vaqti to'g'ri.
 */
async function listAvailableBindingsForStudent(studentId) {
  const student = await User.findById(studentId).select("classes");
  if (!student) {
    throw new NotFoundError("O'quvchi topilmadi");
  }
  const classIds = student.classes || [];
  if (classIds.length === 0) return [];

  const now = new Date();
  const activeSeasons = await TestSeason.find({
    status: "active",
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  }).select("_id");
  const seasonIds = activeSeasons.map((s) => s._id);
  if (seasonIds.length === 0) return [];

  const candidateBindings = await TestBinding.find({
    isActive: true,
    classes: { $in: classIds },
    season: { $in: seasonIds },
  })
    .populate("test", "title questionCount timeLimitMinutes")
    .populate("season", "name endDate")
    .populate("subject", "name")
    .populate("classes", "name")
    .sort({ createdAt: -1 });

  // Faqat savollari yetarli (faol savol soni >= test.questionCount) testlar
  // o'quvchilarga avtomatik ko'rinadi.
  const testIds = [
    ...new Set(
      candidateBindings.map((b) => b.test?._id).filter(Boolean),
    ),
  ];
  const questionCounts = await Question.aggregate([
    { $match: { test: { $in: testIds }, isActive: true } },
    { $group: { _id: "$test", count: { $sum: 1 } } },
  ]);
  const activeCountMap = new Map(
    questionCounts.map((q) => [q._id.toString(), q.count]),
  );

  const bindings = candidateBindings.filter((b) => {
    if (!b.test) return false;
    const activeCount = activeCountMap.get(b.test._id.toString()) || 0;
    return activeCount >= (b.test.questionCount || 0);
  });

  // O'quvchining shu biriktiruvlardagi sessiyalari
  const bindingIds = bindings.map((b) => b._id);
  const sessions = await TestSession.find({
    binding: { $in: bindingIds },
    student: studentId,
  }).select("binding attemptNumber status");

  const sessionMap = new Map();
  for (const s of sessions) {
    const key = s.binding.toString();
    const current = sessionMap.get(key) || {
      maxAttempt: 0,
      hasInProgress: false,
    };
    current.maxAttempt = Math.max(current.maxAttempt, s.attemptNumber);
    if (s.status === "in_progress") current.hasInProgress = true;
    sessionMap.set(key, current);
  }

  return bindings
    .filter((b) => {
      const info = sessionMap.get(b._id.toString());
      if (!info) return true;
      if (info.hasInProgress) return true;
      // Reopen grant bormi?
      const grantsForStudent = (b.reopenGrants || []).filter(
        (g) => g.student.toString() === studentId.toString(),
      ).length;
      const allowedAttempts = 1 + grantsForStudent;
      return info.maxAttempt < allowedAttempts;
    })
    .map((b) => {
      const info = sessionMap.get(b._id.toString());
      return {
        ...b.toObject(),
        nextAttemptNumber: info ? info.maxAttempt + 1 : 1,
        hasInProgress: info ? info.hasInProgress : false,
      };
    });
}

module.exports = {
  listBindingsForTest,
  createBinding,
  updateBinding,
  deleteBinding,
  reopenSessionForStudent,
  listAvailableBindingsForStudent,
};
