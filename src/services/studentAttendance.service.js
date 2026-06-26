const StudentAttendance = require("../models/studentAttendance.model");
const User = require("../models/user.model");
const Class = require("../models/class.model");
const { getTodayNormalized, normalizeDateTashkent } = require("./attendance.service");
const { getPaginationParams, formatPaginationResponse } = require("../utils/pagination");
const { BadRequestError, NotFoundError } = require("../utils/errors");

async function markAttendance({ classId, date, records }, markedBy) {
  const normalizedDate = date ? normalizeDateTashkent(date) : getTodayNormalized();
  const now = new Date();

  const classDoc = await Class.findById(classId).lean();
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const results = [];

  for (const rec of records) {
    const { studentId, status, excuseReason } = rec;

    if (!["present", "late", "absent", "excused"].includes(status)) {
      throw new BadRequestError(`Noto'g'ri status: ${status}`);
    }

    const updated = await StudentAttendance.findOneAndUpdate(
      { student: studentId, date: normalizedDate },
      {
        $set: {
          student: studentId,
          class: classId,
          date: normalizedDate,
          status,
          markedAt: now,
          excuseReason: excuseReason || null,
          autoMarked: false,
          lastModifiedBy: markedBy,
        },
        $setOnInsert: { createdBy: markedBy },
      },
      { upsert: true, new: true, runValidators: true }
    );

    results.push(updated);
  }

  return results;
}

async function updateRecord(recordId, { status, excuseReason }, modifiedBy) {
  const record = await StudentAttendance.findById(recordId);
  if (!record) throw new NotFoundError("Davomat yozuvi topilmadi");

  if (!["present", "late", "absent", "excused"].includes(status)) {
    throw new BadRequestError("Noto'g'ri status");
  }

  record.status = status;
  record.excuseReason = excuseReason !== undefined ? excuseReason : record.excuseReason;
  record.lastModifiedBy = modifiedBy;
  record.markedAt = new Date();
  record.autoMarked = false;

  await record.save();
  return record;
}

async function getTodayClassAttendance(classId, dateInput) {
  const classDoc = await Class.findById(classId).lean();
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  // Sana berilsa o'sha kun, aks holda bugun (default)
  const today = dateInput ? normalizeDateTashkent(dateInput) : getTodayNormalized();

  const students = await User.find(
    { classes: classId, role: "student", isActive: true },
    "firstName lastName _id"
  ).lean();

  const attendanceRecords = await StudentAttendance.find({
    class: classId,
    date: today,
  }).lean();

  const recordMap = {};
  for (const rec of attendanceRecords) {
    recordMap[String(rec.student)] = rec;
  }

  const data = students.map((student) => ({
    student,
    attendance: recordMap[String(student._id)] || null,
  }));

  const summary = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
  for (const { attendance } of data) {
    if (!attendance) {
      summary.unmarked++;
    } else {
      summary[attendance.status] = (summary[attendance.status] || 0) + 1;
    }
  }

  return { classInfo: classDoc, students: data, summary, date: today };
}

async function getClassList() {
  const today = getTodayNormalized();

  const classes = await Class.find({ isActive: true }).lean();

  const result = [];
  for (const cls of classes) {
    const totalStudents = await User.countDocuments({
      classes: cls._id,
      role: "student",
      isActive: true,
    });

    const markedToday = await StudentAttendance.countDocuments({
      class: cls._id,
      date: today,
    });

    result.push({ ...cls, totalStudents, markedToday });
  }

  return result;
}

async function getClassMonthRecords(classId, month, year) {
  const classDoc = await Class.findById(classId).lean();
  if (!classDoc) throw new NotFoundError("Sinf topilmadi");

  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));

  const records = await StudentAttendance.find({
    class: classId,
    date: { $gte: startDate, $lt: endDate },
  })
    .populate("student", "firstName lastName")
    .lean();

  const summary = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const rec of records) {
    summary[rec.status] = (summary[rec.status] || 0) + 1;
  }

  return { classInfo: classDoc, records, summary, month: m, year: y };
}

async function getStudentMonthRecords(studentId, month, year) {
  const student = await User.findById(studentId, "firstName lastName role").lean();
  if (!student || student.role !== "student") throw new NotFoundError("O'quvchi topilmadi");

  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));

  const records = await StudentAttendance.find({
    student: studentId,
    date: { $gte: startDate, $lt: endDate },
  })
    .populate("class", "name")
    .sort({ date: 1 })
    .lean();

  const summary = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const rec of records) {
    summary[rec.status] = (summary[rec.status] || 0) + 1;
  }

  return { student, records, summary, month: m, year: y };
}

async function getAllRecords(req) {
  const { classId, status, month, year } = req.query;
  const { page, limit, skip } = getPaginationParams(req);

  const filter = {};
  if (classId) filter.class = classId;
  if (status) filter.status = status;

  if (month && year) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    filter.date = {
      $gte: new Date(Date.UTC(y, m - 1, 1)),
      $lt: new Date(Date.UTC(y, m, 1)),
    };
  }

  const [records, total] = await Promise.all([
    StudentAttendance.find(filter)
      .populate("student", "firstName lastName")
      .populate("class", "name")
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    StudentAttendance.countDocuments(filter),
  ]);

  return formatPaginationResponse(records, total, page, limit);
}

module.exports = {
  markAttendance,
  updateRecord,
  getTodayClassAttendance,
  getClassList,
  getClassMonthRecords,
  getStudentMonthRecords,
  getAllRecords,
};
