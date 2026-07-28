const express = require("express");
const router = express.Router();

const { protect, authorize, authorizePermission } = require("../middleware/auth.middleware");
const { PERMISSIONS } = require("../utils/permissions");
const {
  createMultiFileUpload,
  createSingleFileUpload,
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
  getProductStats,
  getStudentProducts,
  getStudentProductById,
  updateOrderStatusByOwner,
  addDeliveryImage,
} = require("../controllers/market.controller");

const uploadProductImages = createMultiFileUpload({
  fieldName: "images",
  categories: ["image"],
  maxFiles: 3,
});

const uploadDeliveryImage = createSingleFileUpload({
  fieldName: "deliveryImage",
  categories: ["image"],
});

router.use(protect);

router.get("/admin/products", authorizePermission(PERMISSIONS.MARKET_VIEW), getAdminProducts);
router.get("/admin/products/:productId", validateObjectId("productId"), authorizePermission(PERMISSIONS.MARKET_VIEW), getProductById);
router.get("/admin/products/:productId/stats", validateObjectId("productId"), authorizePermission(PERMISSIONS.MARKET_VIEW), getProductStats);
router.post(
  "/admin/products",
  authorizePermission(PERMISSIONS.MARKET_CREATE),
  uploadProductImages,
  handleFileUploadError,
  createProduct,
);
router.put(
  "/admin/products/:productId",
  validateObjectId("productId"),
  authorizePermission(PERMISSIONS.MARKET_UPDATE),
  uploadProductImages,
  handleFileUploadError,
  updateProduct,
);
router.delete("/admin/products/:productId", validateObjectId("productId"), authorizePermission(PERMISSIONS.MARKET_DELETE), deleteProduct);

router.get("/admin/orders", authorizePermission(PERMISSIONS.MARKET_ORDERS), getAdminOrders);
router.patch(
  "/admin/orders/:orderId/status",
  validateObjectId("orderId"),
  authorizePermission(PERMISSIONS.MARKET_FULFILL),
  uploadDeliveryImage,
  handleFileUploadError,
  updateOrderStatusByOwner,
);

router.patch(
  "/admin/orders/:orderId/delivery-image",
  validateObjectId("orderId"),
  authorizePermission(PERMISSIONS.MARKET_FULFILL),
  uploadDeliveryImage,
  handleFileUploadError,
  addDeliveryImage,
);

router.get("/products", authorize(ROLES.STUDENT), getStudentProducts);
router.get("/products/:productId", validateObjectId("productId"), authorize(ROLES.STUDENT), getStudentProductById);
router.post("/orders", authorize(ROLES.STUDENT), createOrder);
router.get("/orders/my", authorize(ROLES.STUDENT), getMyOrders);
router.patch("/orders/:orderId/cancel", validateObjectId("orderId"), authorize(ROLES.STUDENT), cancelMyOrder);

module.exports = router;
