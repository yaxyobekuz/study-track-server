const MarketProduct = require("../models/marketProduct.model");
const MarketOrder = require("../models/marketOrder.model");
const User = require("../models/user.model");
const Image = require("../models/image.model");
const CoinTransaction = require("../models/coinTransaction.model");
const {
  uploadImageWithVariants,
  deleteImageVariants,
} = require("./image.service");

/**
 * Converts incoming value to positive integer with fallback.
 * @param {string|number} value Raw input value.
 * @param {number} fallback Default value.
 * @returns {number} Parsed number.
 */
const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};

/**
 * Returns product cover image URL from populated images.
 * @param {object} product Product document.
 * @returns {string} Cover URL.
 */
const getProductCoverImageUrl = (product) => {
  const firstImage = product?.images?.[0];
  if (!firstImage) return "";

  return (
    firstImage?.variants?.md?.url ||
    firstImage?.variants?.sm?.url ||
    firstImage?.variants?.original?.url ||
    ""
  );
};

/**
 * Uploads product image files and creates image documents.
 * @param {Array} files Multer files array.
 * @param {string} uploadedBy User ID.
 * @returns {Promise<Array>} Created image documents.
 */
const createProductImages = async (files, uploadedBy) => {
  const createdImages = [];

  try {
    for (const file of files) {
      const processedImage = await uploadImageWithVariants({
        buffer: file.buffer,
        mimeType: file.mimetype,
      });

      const image = await Image.create({
        uploadedBy,
        variants: processedImage.variants,
        extension: processedImage.extension,
        mimeType: processedImage.mimeType,
        originalName: file.originalname,
        originalSizeBytes: file.size,
      });

      createdImages.push(image);
    }

    return createdImages;
  } catch (error) {
    await Promise.allSettled(
      createdImages.map(async (image) => {
        await deleteImageVariants(image.variants);
        await Image.findByIdAndDelete(image._id);
      }),
    );

    throw error;
  }
};

/**
 * Validates product payload fields.
 * @param {object} payload Product payload.
 * @param {boolean} isEdit Edit mode flag.
 */
const validateProductPayload = (payload, isEdit = false) => {
  const requiredFields = ["name", "price", "quantity"];

  if (!isEdit) {
    for (const field of requiredFields) {
      if (
        payload[field] === undefined ||
        payload[field] === null ||
        payload[field] === ""
      ) {
        throw new Error("Majburiy maydonlar to'liq emas");
      }
    }
  }

  if (payload.name !== undefined && String(payload.name).trim().length < 2) {
    throw new Error("Mahsulot nomi kamida 2 ta belgidan iborat bo'lishi kerak");
  }

  if (payload.price !== undefined && Number(payload.price) < 1) {
    throw new Error("Mahsulot narxi kamida 1 coin bo'lishi kerak");
  }

  if (payload.quantity !== undefined && Number(payload.quantity) < 0) {
    throw new Error("Mahsulot soni manfiy bo'lishi mumkin emas");
  }
};

/**
 * Creates market product with images.
 * @param {object} payload Product payload.
 * @param {Array} files Product image files.
 * @param {string} ownerId Owner user ID.
 * @returns {Promise<object>} Created product.
 */
const createProduct = async (payload, files, ownerId) => {
  validateProductPayload(payload, false);

  if (!Array.isArray(files) || files.length < 1 || files.length > 3) {
    throw new Error("Mahsulot rasmlari 1 tadan 3 tagacha bo'lishi kerak");
  }

  const imageDocuments = await createProductImages(files, ownerId);

  const created = await MarketProduct.create({
    name: String(payload.name).trim(),
    description: String(payload.description || "").trim(),
    price: Number(payload.price),
    quantity: Number(payload.quantity),
    images: imageDocuments.map((image) => image._id),
    createdBy: ownerId,
  });

  return MarketProduct.findById(created._id)
    .populate("images")
    .populate("createdBy", "firstName lastName username");
};

/**
 * Returns paginated admin products list.
 * @param {object} params Query params.
 * @returns {Promise<object>} Product list with pagination.
 */
const getAdminProducts = async ({ page = 1, limit = 12 } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 12);
  const skip = (pageNumber - 1) * limitNumber;

  const query = { isArchived: false };

  const [products, totalItems] = await Promise.all([
    MarketProduct.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .populate("images")
      .populate("createdBy", "firstName lastName")
      .lean(),
    MarketProduct.countDocuments(query),
  ]);

  return {
    data: products,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      totalItems,
      totalPages: Math.ceil(totalItems / limitNumber) || 1,
      hasNextPage: pageNumber * limitNumber < totalItems,
      hasPrevPage: pageNumber > 1,
    },
  };
};

/**
 * Returns public products for students.
 * @param {object} params Query params.
 * @returns {Promise<object>} Product list with pagination.
 */
const getStudentProducts = async ({ page = 1, limit = 12 } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 12);
  const skip = (pageNumber - 1) * limitNumber;

  const query = {
    isActive: true,
    isArchived: false,
  };

  const [products, totalItems] = await Promise.all([
    MarketProduct.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .populate("images")
      .lean(),
    MarketProduct.countDocuments(query),
  ]);

  return {
    data: products,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      totalItems,
      totalPages: Math.ceil(totalItems / limitNumber) || 1,
      hasNextPage: pageNumber * limitNumber < totalItems,
      hasPrevPage: pageNumber > 1,
    },
  };
};

/**
 * Returns product detail by ID.
 * @param {string} productId Product ID.
 * @param {boolean} isAdmin Admin access flag.
 * @returns {Promise<object>} Product detail.
 */
const getProductById = async (productId, isAdmin = false) => {
  const query = { _id: productId };

  if (!isAdmin) {
    query.isActive = true;
    query.isArchived = false;
  }

  const product = await MarketProduct.findOne(query)
    .populate("images")
    .populate("createdBy", "firstName lastName username");

  if (!product) {
    throw new Error("Mahsulot topilmadi");
  }

  return product;
};

/**
 * Updates product fields and image set.
 * @param {string} productId Product ID.
 * @param {object} payload Update payload.
 * @param {Array} files New image files.
 * @param {string} ownerId Owner user ID.
 * @returns {Promise<object>} Updated product.
 */
const updateProduct = async (productId, payload, files, ownerId) => {
  validateProductPayload(payload, true);

  const product = await MarketProduct.findOne({
    _id: productId,
    isArchived: false,
  }).populate("images");

  if (!product) {
    throw new Error("Mahsulot topilmadi");
  }

  const removeImageIds = Array.isArray(payload.removeImageIds)
    ? payload.removeImageIds
    : [];
  const normalizedRemoveIds = removeImageIds.map((id) => String(id));

  const existingImageIds = product.images.map((image) => String(image._id));
  const invalidRemoveId = normalizedRemoveIds.find(
    (id) => !existingImageIds.includes(id),
  );

  if (invalidRemoveId) {
    throw new Error("Noto'g'ri rasm identifikatori yuborildi");
  }

  if (Array.isArray(files) && files.length > 3) {
    throw new Error("Maksimal 3 ta rasm yuklash mumkin");
  }

  const preservedImageDocs = product.images.filter(
    (image) => !normalizedRemoveIds.includes(String(image._id)),
  );
  const removedImageDocs = product.images.filter((image) =>
    normalizedRemoveIds.includes(String(image._id)),
  );

  const newImageDocs = files?.length
    ? await createProductImages(files, ownerId)
    : [];

  const totalImages = preservedImageDocs.length + newImageDocs.length;
  if (totalImages < 1 || totalImages > 3) {
    throw new Error("Mahsulot rasmlari 1 tadan 3 tagacha bo'lishi kerak");
  }

  if (payload.name !== undefined) product.name = String(payload.name).trim();
  if (payload.description !== undefined)
    product.description = String(payload.description || "").trim();
  if (payload.price !== undefined) product.price = Number(payload.price);
  if (payload.quantity !== undefined)
    product.quantity = Number(payload.quantity);
  if (payload.isActive !== undefined) {
    product.isActive =
      payload.isActive === true || String(payload.isActive) === "true";
  }

  product.images = [...preservedImageDocs, ...newImageDocs].map(
    (image) => image._id,
  );

  await product.save();

  if (removedImageDocs.length > 0) {
    await Promise.allSettled(
      removedImageDocs.map(async (image) => {
        await deleteImageVariants(image.variants);
        await Image.findByIdAndDelete(image._id);
      }),
    );
  }

  return getProductById(productId, true);
};

/**
 * Soft deletes a product.
 * @param {string} productId Product ID.
 * @returns {Promise<object>} Updated product.
 */
const deleteProduct = async (productId) => {
  const product = await MarketProduct.findOne({
    _id: productId,
    isArchived: false,
  });

  if (!product) {
    throw new Error("Mahsulot topilmadi");
  }

  product.isArchived = true;
  product.isActive = false;
  product.archivedAt = new Date();
  await product.save();

  return product;
};

/**
 * Creates purchase transaction document.
 * @param {object} params Transaction params.
 * @returns {Promise<void>}
 */
const createPurchaseTransaction = async ({
  studentId,
  orderId,
  productId,
  quantity,
  unitPrice,
  totalPrice,
  balanceAfter,
}) => {
  await CoinTransaction.create({
    student: studentId,
    amount: totalPrice,
    type: "market_purchase",
    description: `Marketdan mahsulot buyurtma qilindi: -${totalPrice} coin`,
    balanceAfter,
    meta: {
      orderId,
      productId,
      quantity,
      unitPrice,
      totalPrice,
    },
    date: new Date(),
  });
};

/**
 * Creates refund transaction document.
 * @param {object} params Transaction params.
 * @returns {Promise<void>}
 */
const createRefundTransaction = async ({
  studentId,
  orderId,
  productId,
  quantity,
  unitPrice,
  totalPrice,
  balanceAfter,
  reason,
}) => {
  await CoinTransaction.create({
    student: studentId,
    amount: totalPrice,
    type: "market_refund",
    description: `Market buyurtmasi uchun qaytarim: +${totalPrice} coin (${reason})`,
    balanceAfter,
    meta: {
      orderId,
      productId,
      quantity,
      unitPrice,
      totalPrice,
    },
    date: new Date(),
  });
};

/**
 * Places a student order for product.
 * @param {string} studentId Student ID.
 * @param {object} payload Order payload.
 * @returns {Promise<object>} Created order.
 */
const createOrder = async (studentId, payload) => {
  const quantity = Number(payload.quantity);

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Buyurtma soni kamida 1 bo'lishi kerak");
  }

  // Jarima bali 3 dan yuqori bo'lsa do'kondan foydalanish cheklangan
  const student = await User.findById(studentId).select("penaltyPoints");
  if (student && student.penaltyPoints > 3) {
    throw new Error("Jarima balingiz 3 dan yuqori. Do'kondan foydalanish cheklangan.");
  }

  const product = await MarketProduct.findOne({
    _id: payload.productId,
    isActive: true,
    isArchived: false,
  }).populate("images");

  if (!product) {
    throw new Error("Mahsulot topilmadi yoki faol emas");
  }

  if (product.quantity < quantity) {
    throw new Error("Omborda yetarli mahsulot mavjud emas");
  }

  const totalPrice = Number(product.price) * quantity;

  const updatedStudent = await User.findOneAndUpdate(
    {
      _id: studentId,
      role: "student",
      coinBalance: { $gte: totalPrice },
    },
    { $inc: { coinBalance: -totalPrice } },
    { new: true },
  );

  if (!updatedStudent) {
    throw new Error("Coin yetarli emas");
  }

  const updatedProduct = await MarketProduct.findOneAndUpdate(
    {
      _id: product._id,
      isArchived: false,
      isActive: true,
      quantity: { $gte: quantity },
    },
    { $inc: { quantity: -quantity } },
    { new: true },
  ).populate("images");

  if (!updatedProduct) {
    await User.findByIdAndUpdate(studentId, {
      $inc: { coinBalance: totalPrice },
    });
    throw new Error("Omborda yetarli mahsulot qolmagan");
  }

  const createdOrder = await MarketOrder.create({
    student: studentId,
    product: product._id,
    quantity,
    unitPrice: Number(product.price),
    totalPrice,
    productSnapshot: {
      name: product.name,
      description: product.description || "",
      imageUrl: getProductCoverImageUrl(product),
    },
    statusHistory: [
      {
        status: "pending",
        changedBy: studentId,
        note: "Buyurtma yaratildi",
        changedAt: new Date(),
      },
    ],
  });

  await createPurchaseTransaction({
    orderId: createdOrder._id,
    studentId,
    productId: product._id,
    quantity,
    totalPrice,
    unitPrice: Number(product.price),
    balanceAfter: updatedStudent.coinBalance,
  });

  return MarketOrder.findById(createdOrder._id)
    .populate("product", "name quantity price")
    .populate("student", "firstName lastName username coinBalance classes");
};

/**
 * Applies order refund and stock rollback.
 * @param {object} order Order document.
 * @param {string} reason Refund reason.
 * @returns {Promise<object>} Updated student.
 */
const applyRefundAndRollback = async (order, reason) => {
  await MarketProduct.findByIdAndUpdate(order.product, {
    $inc: { quantity: order.quantity },
  });

  const updatedStudent = await User.findByIdAndUpdate(
    order.student,
    { $inc: { coinBalance: order.totalPrice } },
    { new: true },
  );

  await createRefundTransaction({
    reason,
    orderId: order._id,
    studentId: order.student,
    productId: order.product,
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    totalPrice: order.totalPrice,
    balanceAfter: updatedStudent.coinBalance,
  });

  return updatedStudent;
};

/**
 * Cancels order by student.
 * @param {string} orderId Order ID.
 * @param {string} studentId Student ID.
 * @returns {Promise<object>} Updated order.
 */
const cancelOrderByStudent = async (orderId, studentId) => {
  const order = await MarketOrder.findOne({ _id: orderId, student: studentId });

  if (!order) {
    throw new Error("Buyurtma topilmadi");
  }

  if (order.status === "approved" || order.status === "rejected") {
    throw new Error("Ushbu buyurtmani bekor qilib bo'lmaydi");
  }

  if (order.status === "cancelled") {
    throw new Error("Buyurtma allaqachon bekor qilingan");
  }

  order.status = "cancelled";
  order.rejectReason = "";

  await applyRefundAndRollback(order, "o'quvchi tomonidan bekor qilindi");
  await order.save();

  return MarketOrder.findById(order._id)
    .populate("product", "name quantity price")
    .populate("student", "firstName lastName username coinBalance classes");
};

/**
 * Updates order status by owner.
 * @param {string} orderId Order ID.
 * @param {object} payload Status payload.
 * @param {string} ownerId Owner user ID.
 * @returns {Promise<object>} Updated order.
 */
const updateOrderStatusByOwner = async (orderId, payload, ownerId) => {
  const status = String(payload.status || "").trim();
  const rejectReason = String(payload.rejectReason || "").trim();

  if (!["approved", "rejected"].includes(status)) {
    throw new Error("Noto'g'ri status yuborildi");
  }

  const order = await MarketOrder.findById(orderId)
    .populate("student", "firstName lastName username coinBalance classes")
    .populate("product", "name quantity price")
    .populate("student.classes", "name");

  if (!order) {
    throw new Error("Buyurtma topilmadi");
  }

  if (order.status !== "pending") {
    throw new Error("Faqat kutilayotgan buyurtma holatini o'zgartirish mumkin");
  }

  if (status === "rejected" && rejectReason.length < 3) {
    throw new Error("Rad etish sababi majburiy");
  }

  order.status = status;
  order.rejectReason = status === "rejected" ? rejectReason : "";

  if (status === "rejected") {
    await applyRefundAndRollback(order, "owner tomonidan rad etildi");
  }

  order.statusHistory.push({
    status,
    changedBy: ownerId,
    note: status === "rejected" ? rejectReason : "buyurtma tasdiqlandi",
    changedAt: new Date(),
  });

  await order.save();

  return MarketOrder.findById(order._id)
    .populate("student", "firstName lastName username coinBalance classes")
    .populate("product", "name quantity price")
    .populate("student.classes", "name");
};

/**
 * Returns paginated admin orders list.
 * @param {object} params Query params.
 * @returns {Promise<object>} Orders with pagination.
 */
const getAdminOrders = async ({ page = 1, limit = 20, status = "" } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 20);
  const skip = (pageNumber - 1) * limitNumber;

  const query = {};
  if (["pending", "approved", "rejected", "cancelled"].includes(status)) {
    query.status = status;
  }

  const [orders, totalItems] = await Promise.all([
    MarketOrder.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .populate("product", "name quantity price")
      .populate("student", "firstName lastName username coinBalance classes")
      .populate("student.classes", "name")
      .lean(),
    MarketOrder.countDocuments(query),
  ]);

  return {
    data: orders,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      totalItems,
      totalPages: Math.ceil(totalItems / limitNumber) || 1,
      hasNextPage: pageNumber * limitNumber < totalItems,
      hasPrevPage: pageNumber > 1,
    },
  };
};

/**
 * Returns paginated student orders list.
 * @param {string} studentId Student ID.
 * @param {object} params Query params.
 * @returns {Promise<object>} Orders with pagination.
 */
const getStudentOrders = async (studentId, { page = 1, limit = 20 } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 20);
  const skip = (pageNumber - 1) * limitNumber;

  const query = { student: studentId };

  const [orders, totalItems] = await Promise.all([
    MarketOrder.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber)
      .populate("product", "name quantity price")
      .lean(),
    MarketOrder.countDocuments(query),
  ]);

  return {
    data: orders,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      totalItems,
      totalPages: Math.ceil(totalItems / limitNumber) || 1,
      hasNextPage: pageNumber * limitNumber < totalItems,
      hasPrevPage: pageNumber > 1,
    },
  };
};

module.exports = {
  createOrder,
  getProductById,
  createProduct,
  deleteProduct,
  updateProduct,
  getAdminOrders,
  getAdminProducts,
  getStudentOrders,
  getStudentProducts,
  cancelOrderByStudent,
  updateOrderStatusByOwner,
};
