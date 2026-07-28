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
const {
  protect,
  authorize,
  authorizePermission,
  authorizeSection,
} = require("../middleware/auth.middleware");
const { PERMISSIONS, SECTIONS } = require("../utils/permissions");
const { createSingleFileUpload, handleFileUploadError } = require("../middleware/fileUpload.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

// All routes are protected
router.use(protect);

// Bo'limga umumiy kirish (owner, teacher yoki `messages.*` ruxsati bor xodim)
router.use(authorizeSection(SECTIONS.MESSAGES, ROLES.TEACHER));

// Routes
router.get("/", authorizePermission(PERMISSIONS.MESSAGES_VIEW, ROLES.TEACHER), getMessages);
router.post(
  "/",
  authorizePermission(PERMISSIONS.MESSAGES_CREATE, ROLES.TEACHER),
  createSingleFileUpload({ categories: ["image", "document"] }),
  handleFileUploadError,
  sendMessage
);

router.get("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.MESSAGES_VIEW, ROLES.TEACHER), getMessageById);

router.patch("/:id/cancel", validateObjectId("id"), authorizePermission(PERMISSIONS.MESSAGES_CANCEL, ROLES.TEACHER), cancelMessage);

module.exports = router;
