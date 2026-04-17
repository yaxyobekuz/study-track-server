const asyncHandler = require("../middleware/async.middleware");
const marketService = require("../services/market.service");

/**
 * GET /api/market/admin/products
 * @access Private (owner)
 */
const getAdminProducts = asyncHandler(async (req, res) => {
  const result = await marketService.getAdminProducts(req.query);

  return res.json({
    success: true,
    data: result.data,
    pagination: result.pagination,
  });
});

/**
 * GET /api/market/products
 * @access Private (student)
 */
const getStudentProducts = asyncHandler(async (req, res) => {
  const result = await marketService.getStudentProducts(req.query);

  return res.json({
    success: true,
    data: result.data,
    pagination: result.pagination,
  });
});

/**
 * GET /api/market/admin/products/:productId
 * @access Private (owner)
 */
const getAdminProductById = asyncHandler(async (req, res) => {
  const product = await marketService.getProductById(
    req.params.productId,
    true,
  );

  return res.json({ success: true, data: product });
});

/**
 * GET /api/market/products/:productId
 * @access Private (student)
 */
const getStudentProductById = asyncHandler(async (req, res) => {
  const product = await marketService.getProductById(
    req.params.productId,
    false,
  );

  return res.json({ success: true, data: product });
});

/**
 * POST /api/market/admin/products
 * @access Private (owner)
 */
const createProduct = asyncHandler(async (req, res) => {
  const product = await marketService.createProduct(
    req.body,
    req.files || [],
    req.user._id,
  );

  return res.status(201).json({
    success: true,
    message: "Mahsulot muvaffaqiyatli yaratildi",
    data: product,
  });
});

/**
 * PUT /api/market/admin/products/:productId
 * @access Private (owner)
 */
const updateProduct = asyncHandler(async (req, res) => {
  const removeImageIdsRaw = req.body.removeImageIds;
  const removeImageIds = Array.isArray(removeImageIdsRaw)
    ? removeImageIdsRaw
    : typeof removeImageIdsRaw === "string" && removeImageIdsRaw.trim()
      ? removeImageIdsRaw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

  const product = await marketService.updateProduct(
    req.params.productId,
    {
      ...req.body,
      removeImageIds,
    },
    req.files || [],
    req.user._id,
  );

  return res.json({
    success: true,
    message: "Mahsulot yangilandi",
    data: product,
  });
});

/**
 * DELETE /api/market/admin/products/:productId
 * @access Private (owner)
 */
const deleteProduct = asyncHandler(async (req, res) => {
  await marketService.deleteProduct(req.params.productId);

  return res.json({
    success: true,
    message: "Mahsulot o'chirildi",
  });
});

/**
 * GET /api/market/admin/orders
 * @access Private (owner)
 */
const getAdminOrders = asyncHandler(async (req, res) => {
  const result = await marketService.getAdminOrders(req.query);

  return res.json({
    success: true,
    data: result.data,
    pagination: result.pagination,
  });
});

/**
 * PATCH /api/market/admin/orders/:orderId/status
 * @access Private (owner)
 */
const updateOrderStatusByOwner = asyncHandler(async (req, res) => {
  const order = await marketService.updateOrderStatusByOwner(
    req.params.orderId,
    req.body,
    req.user._id,
    req.file || null,
  );

  return res.json({
    success: true,
    message: "Buyurtma holati yangilandi",
    data: order,
  });
});

/**
 * PATCH /api/market/admin/orders/:orderId/delivery-image
 * @access Private (owner)
 */
const addDeliveryImage = asyncHandler(async (req, res) => {
  const order = await marketService.addDeliveryImageByOwner(
    req.params.orderId,
    req.file || null,
    req.user._id,
  );

  return res.json({
    success: true,
    message: "Yetkazib berish rasmi qo'shildi",
    data: order,
  });
});

/**
 * POST /api/market/orders
 * @access Private (student)
 */
const createOrder = asyncHandler(async (req, res) => {
  const order = await marketService.createOrder(req.user._id, req.body);

  return res.status(201).json({
    success: true,
    message: "Buyurtma qabul qilindi",
    data: order,
  });
});

/**
 * GET /api/market/orders/my
 * @access Private (student)
 */
const getMyOrders = asyncHandler(async (req, res) => {
  const result = await marketService.getStudentOrders(
    req.user._id,
    req.query,
  );

  return res.json({
    success: true,
    data: result.data,
    pagination: result.pagination,
  });
});

/**
 * PATCH /api/market/orders/:orderId/cancel
 * @access Private (student)
 */
const cancelMyOrder = asyncHandler(async (req, res) => {
  const order = await marketService.cancelOrderByStudent(
    req.params.orderId,
    req.user._id,
  );

  return res.json({
    success: true,
    message: "Buyurtma bekor qilindi",
    data: order,
  });
});

module.exports = {
  createOrder,
  getMyOrders,
  createProduct,
  deleteProduct,
  updateProduct,
  getAdminOrders,
  cancelMyOrder,
  getAdminProducts,
  getProductById: getAdminProductById,
  getStudentProducts,
  getStudentProductById,
  updateOrderStatusByOwner,
  addDeliveryImage,
};
