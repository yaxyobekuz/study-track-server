const express = require("express");
const router = express.Router();
const { protect, authorize } = require("../middleware/auth.middleware");
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
router.get("/active", authorize(ROLES.OWNER, ROLES.RECEPTION), getActive);

// Boshqaruv (owner)
router.get("/", authorize(ROLES.OWNER), getAll);
router.post("/", authorize(ROLES.OWNER), create);
router.put("/:id", validateObjectId("id"), authorize(ROLES.OWNER), update);
router.delete("/:id", validateObjectId("id"), authorize(ROLES.OWNER), remove);

module.exports = router;
