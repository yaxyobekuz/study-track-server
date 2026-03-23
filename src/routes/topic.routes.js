// Express
const express = require("express");
const router = express.Router();

// Controllers
const {
  uploadTopics,
  getTopicsBySubject,
  deleteTopicsBySubject,
} = require("../controllers/topic.controller");

// Middleware
const { protect, authorize } = require("../middleware/auth.middleware");
const { createSingleFileUpload, handleFileUploadError } = require("../middleware/fileUpload.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// Routes
router.post(
  "/upload",
  protect,
  authorize(ROLES.OWNER),
  createSingleFileUpload({ categories: ["document"] }),
  handleFileUploadError,
  uploadTopics
);

router.get("/subject/:id", protect, validateObjectId("id"), getTopicsBySubject);

router.delete("/subject/:id", protect, authorize(ROLES.OWNER), validateObjectId("id"), deleteTopicsBySubject);

module.exports = router;
