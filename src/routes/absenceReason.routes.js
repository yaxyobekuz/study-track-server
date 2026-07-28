const express = require("express");
const router = express.Router();
const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");
const {
  create,
  getAll,
  getActive,
  getApplicable,
  update,
  remove,
} = require("../controllers/absenceReason.controller");

router.use(protect);

// O'z roliga tegishli sabablar (istalgan autentifikatsiyalangan foydalanuvchi)
router.get("/applicable", getApplicable);

// Barcha aktiv sabablar - admin belgilash sahifasi uchun (rol bo'yicha filtrlash)
router.get("/active", authorizePermission(PERMISSIONS.ATTENDANCE, ROLES.RECEPTION), getActive);

// Boshqaruv (owner)
router.get("/", authorizePermission(PERMISSIONS.ATTENDANCE), getAll);
router.post("/", authorizePermission(PERMISSIONS.ATTENDANCE), create);
router.put("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.ATTENDANCE), update);
router.delete("/:id", validateObjectId("id"), authorizePermission(PERMISSIONS.ATTENDANCE), remove);

module.exports = router;
