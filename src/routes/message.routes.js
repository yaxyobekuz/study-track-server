// Express
const express = require("express");
const router = express.Router();

// Controllers
const {
  sendMessage,
  getMessages,
  getMessageById,
} = require("../controllers/message.controller");

// Middlewares
const { protect, authorize } = require("../middleware/auth.middleware");
const { uploadSingle, handleUploadError } = require("../middleware/upload.middleware");

// All routes are protected
router.use(protect);

// Only owner and teacher can access these routes
router.use(authorize("owner", "teacher"));

// Routes
router
  .route("/")
  .get(getMessages)
  .post(uploadSingle, handleUploadError, sendMessage);

router.route("/:id").get(getMessageById);

module.exports = router;
