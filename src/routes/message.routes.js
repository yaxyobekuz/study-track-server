// Express
const express = require("express");
const router = express.Router();

// Controllers
const {
  sendMessage,
  getMessages,
  getMessageById,
  cancelMessage,
} = require("../controllers/message.controller");

// Middlewares
const { protect, authorize } = require("../middleware/auth.middleware");
const { createSingleFileUpload, handleFileUploadError } = require("../middleware/fileUpload.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// Only owner and teacher can access these routes
router.use(authorize(ROLES.OWNER, ROLES.TEACHER));

// Routes
router
  .route("/")
  .get(getMessages)
  .post(createSingleFileUpload({ categories: ["image", "document"] }), handleFileUploadError, sendMessage);

router.route("/:id").all(validateObjectId("id")).get(getMessageById);

router.route("/:id/cancel").all(validateObjectId("id")).patch(cancelMessage);

module.exports = router;
