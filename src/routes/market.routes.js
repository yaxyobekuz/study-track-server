const express = require("express");
const router = express.Router();

const { protect, authorize } = require("../middleware/auth.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");
const { validateObjectId } = require("../middleware/validate.middleware");
const { ROLES } = require("../utils/constants");

const {
  createOrder,
  getMyOrders,
  createProduct,
  deleteProduct,
  updateProduct,
  getAdminOrders,
  cancelMyOrder,
  getAdminProducts,
  getProductById,
  getStudentProducts,
  getStudentProductById,
  updateOrderStatusByOwner,
} = require("../controllers/market.controller");

const uploadProductImages = createMultiFileUpload({
  fieldName: "images",
  categories: ["image"],
  maxFiles: 3,
});

router.use(protect);

router.get("/admin/products", authorize(ROLES.OWNER), getAdminProducts);
router.get("/admin/products/:productId", validateObjectId("productId"), authorize(ROLES.OWNER), getProductById);
router.post(
  "/admin/products",
  authorize(ROLES.OWNER),
  uploadProductImages,
  handleFileUploadError,
  createProduct,
);
router.put(
  "/admin/products/:productId",
  validateObjectId("productId"),
  authorize(ROLES.OWNER),
  uploadProductImages,
  handleFileUploadError,
  updateProduct,
);
router.delete("/admin/products/:productId", validateObjectId("productId"), authorize(ROLES.OWNER), deleteProduct);

router.get("/admin/orders", authorize(ROLES.OWNER), getAdminOrders);
router.patch(
  "/admin/orders/:orderId/status",
  validateObjectId("orderId"),
  authorize(ROLES.OWNER),
  updateOrderStatusByOwner,
);

router.get("/products", authorize(ROLES.STUDENT), getStudentProducts);
router.get("/products/:productId", validateObjectId("productId"), authorize(ROLES.STUDENT), getStudentProductById);
router.post("/orders", authorize(ROLES.STUDENT), createOrder);
router.get("/orders/my", authorize(ROLES.STUDENT), getMyOrders);
router.patch("/orders/:orderId/cancel", validateObjectId("orderId"), authorize(ROLES.STUDENT), cancelMyOrder);

module.exports = router;
