const marketService = require("../services/market.service");

/**
 * GET /api/market/admin/products
 * @access Private (owner)
 */
const getAdminProducts = async (req, res) => {
  try {
    const result = await marketService.getAdminProducts(req.query);

    return res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Mahsulotlarni olishda xatolik",
    });
  }
};

/**
 * GET /api/market/products
 * @access Private (student)
 */
const getStudentProducts = async (req, res) => {
  try {
    const result = await marketService.getStudentProducts(req.query);

    return res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Mahsulotlarni olishda xatolik",
    });
  }
};

/**
 * GET /api/market/admin/products/:productId
 * @access Private (owner)
 */
const getAdminProductById = async (req, res) => {
  try {
    const product = await marketService.getProductById(
      req.params.productId,
      true,
    );

    return res.json({ success: true, data: product });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error.message || "Mahsulot topilmadi",
    });
  }
};

/**
 * GET /api/market/products/:productId
 * @access Private (student)
 */
const getStudentProductById = async (req, res) => {
  try {
    const product = await marketService.getProductById(
      req.params.productId,
      false,
    );

    return res.json({ success: true, data: product });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error.message || "Mahsulot topilmadi",
    });
  }
};

/**
 * POST /api/market/admin/products
 * @access Private (owner)
 */
const createProduct = async (req, res) => {
  try {
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
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Mahsulot yaratishda xatolik",
    });
  }
};

/**
 * PUT /api/market/admin/products/:productId
 * @access Private (owner)
 */
const updateProduct = async (req, res) => {
  try {
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
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Mahsulot yangilashda xatolik",
    });
  }
};

/**
 * DELETE /api/market/admin/products/:productId
 * @access Private (owner)
 */
const deleteProduct = async (req, res) => {
  try {
    await marketService.deleteProduct(req.params.productId);

    return res.json({
      success: true,
      message: "Mahsulot o'chirildi",
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error.message || "Mahsulot topilmadi",
    });
  }
};

/**
 * GET /api/market/admin/orders
 * @access Private (owner)
 */
const getAdminOrders = async (req, res) => {
  try {
    const result = await marketService.getAdminOrders(req.query);

    return res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Buyurtmalarni olishda xatolik",
    });
  }
};

/**
 * PATCH /api/market/admin/orders/:orderId/status
 * @access Private (owner)
 */
const updateOrderStatusByOwner = async (req, res) => {
  try {
    const order = await marketService.updateOrderStatusByOwner(
      req.params.orderId,
      req.body,
      req.user._id,
    );

    return res.json({
      success: true,
      message: "Buyurtma holati yangilandi",
      data: order,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Buyurtma holatini yangilashda xatolik",
    });
  }
};

/**
 * POST /api/market/orders
 * @access Private (student)
 */
const createOrder = async (req, res) => {
  try {
    const order = await marketService.createOrder(req.user._id, req.body);

    return res.status(201).json({
      success: true,
      message: "Buyurtma qabul qilindi",
      data: order,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Buyurtma yaratishda xatolik",
    });
  }
};

/**
 * GET /api/market/orders/my
 * @access Private (student)
 */
const getMyOrders = async (req, res) => {
  try {
    const result = await marketService.getStudentOrders(
      req.user._id,
      req.query,
    );

    return res.json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Buyurtmalarni olishda xatolik",
    });
  }
};

/**
 * PATCH /api/market/orders/:orderId/cancel
 * @access Private (student)
 */
const cancelMyOrder = async (req, res) => {
  try {
    const order = await marketService.cancelOrderByStudent(
      req.params.orderId,
      req.user._id,
    );

    return res.json({
      success: true,
      message: "Buyurtma bekor qilindi",
      data: order,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Buyurtmani bekor qilishda xatolik",
    });
  }
};

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
};
