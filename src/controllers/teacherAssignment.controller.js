const asyncHandler = require("../middleware/async.middleware");
const teacherAssignmentService = require("../services/teacherAssignment.service");

/**
 * Biriktiruvlar ro'yxatini olish
 * GET /api/teacher-assignments
 */
const getAssignments = asyncHandler(async (req, res) => {
  const result = await teacherAssignmentService.listAssignments(req);
  res.json(result);
});

/**
 * O'qituvchining o'z biriktiruvlarini olish
 * GET /api/teacher-assignments/my
 */
const getMyAssignments = asyncHandler(async (req, res) => {
  const assignments = await teacherAssignmentService.getAssignmentsForTeacher(
    req.user._id,
    req.query.season,
  );
  res.json({
    success: true,
    data: assignments,
  });
});

/**
 * Biriktiruv yaratish
 * POST /api/teacher-assignments
 */
const createAssignment = asyncHandler(async (req, res) => {
  const assignment = await teacherAssignmentService.createAssignment(
    req.body,
    req.user._id,
  );
  res.status(201).json({
    success: true,
    data: assignment,
  });
});

/**
 * Bir nechta biriktiruvni bittada yaratish (bulk)
 * POST /api/teacher-assignments/bulk
 */
const bulkCreateAssignments = asyncHandler(async (req, res) => {
  const result = await teacherAssignmentService.bulkCreateAssignments(
    req.body,
    req.user._id,
  );
  res.status(201).json({
    success: true,
    data: result,
  });
});

/**
 * Biriktiruvni yangilash
 * PUT /api/teacher-assignments/:id
 */
const updateAssignment = asyncHandler(async (req, res) => {
  const assignment = await teacherAssignmentService.updateAssignment(
    req.params.id,
    req.body,
  );
  res.json({
    success: true,
    data: assignment,
  });
});

/**
 * Biriktiruvni o'chirish
 * DELETE /api/teacher-assignments/:id
 */
const deleteAssignment = asyncHandler(async (req, res) => {
  await teacherAssignmentService.deleteAssignment(req.params.id);
  res.json({
    success: true,
    message: "Biriktiruv o'chirildi",
  });
});

module.exports = {
  getAssignments,
  getMyAssignments,
  createAssignment,
  bulkCreateAssignments,
  updateAssignment,
  deleteAssignment,
};
