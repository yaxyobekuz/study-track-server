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
const { uploadSingle, handleUploadError } = require("../middleware/upload.middleware");

// Routes
router.post(
  "/upload",
  protect,
  authorize("owner"),
  uploadSingle,
  handleUploadError,
  uploadTopics
);

router.get("/subject/:id", protect, getTopicsBySubject);

router.delete("/subject/:id", protect, authorize("owner"), deleteTopicsBySubject);

module.exports = router;
