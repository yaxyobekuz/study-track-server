const express = require("express");
const router = express.Router();

const { protect, authorize } = require("../middleware/auth.middleware");
const {
  createMultiFileUpload,
  handleFileUploadError,
} = require("../middleware/fileUpload.middleware");

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

router.get("/admin/products", authorize("owner"), getAdminProducts);
router.get("/admin/products/:productId", authorize("owner"), getProductById);
router.post(
  "/admin/products",
  authorize("owner"),
  uploadProductImages,
  handleFileUploadError,
  createProduct,
);
router.put(
  "/admin/products/:productId",
  authorize("owner"),
  uploadProductImages,
  handleFileUploadError,
  updateProduct,
);
router.delete("/admin/products/:productId", authorize("owner"), deleteProduct);

router.get("/admin/orders", authorize("owner"), getAdminOrders);
router.patch(
  "/admin/orders/:orderId/status",
  authorize("owner"),
  updateOrderStatusByOwner,
);

router.get("/products", authorize("student"), getStudentProducts);
router.get("/products/:productId", authorize("student"), getStudentProductById);
router.post("/orders", authorize("student"), createOrder);
router.get("/orders/my", authorize("student"), getMyOrders);
router.patch("/orders/:orderId/cancel", authorize("student"), cancelMyOrder);

module.exports = router;
