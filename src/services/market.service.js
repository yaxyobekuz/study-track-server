const prisma = require("../config/prisma");
const {
  uploadImageWithVariants,
  deleteImageVariants,
} = require("./image.service");

/**
 * Converts incoming value to positive integer with fallback.
 */
const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};

/**
 * Returns product cover image URL from populated images.
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

// MarketProduct.images junction → eski [Image] shakliga tekislaydi
function flattenProduct(product) {
  if (!product) return product;
  const out = { ...product };
  if (Array.isArray(product.images)) {
    // include: { images: { include: { image }, orderBy: position } }
    out.images = product.images.map((pi) =>
      pi.image ? { ...pi.image } : pi,
    );
  }
  return out;
}

// createdBy soft ref (relation yo'q) yuklovchi
async function attachCreatedBy(product) {
  if (!product || !product.createdBy) return product;
  const u = await prisma.user.findUnique({
    where: { id: product.createdBy },
    select: { id: true, firstName: true, lastName: true, username: true },
  });
  return { ...product, createdBy: u ? { ...u } : null };
}

// MarketOrder ref (student/product/deliveryImage) larni qo'lda yuklab tekislaydi
async function attachOrderRefs(orders) {
  const arr = Array.isArray(orders) ? orders : [orders];
  const studentIds = [...new Set(arr.map((o) => o.studentId).filter(Boolean))];
  const productIds = [...new Set(arr.map((o) => o.productId).filter(Boolean))];
  const imageIds = [...new Set(arr.map((o) => o.deliveryImage).filter(Boolean))];

  const [students, products, images] = await Promise.all([
    studentIds.length
      ? prisma.user.findMany({
          where: { id: { in: studentIds } },
          select: {
            id: true, firstName: true, lastName: true, username: true, coinBalance: true,
            classes: { include: { class: { select: { id: true, name: true } } } },
          },
        })
      : [],
    productIds.length
      ? prisma.marketProduct.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true, quantity: true, price: true },
        })
      : [],
    imageIds.length
      ? prisma.image.findMany({ where: { id: { in: imageIds } } })
      : [],
  ]);

  const sMap = new Map(students.map((s) => [s.id, { ...s, classes: s.classes.map((uc) => ({ ...uc.class })) }]));
  const pMap = new Map(products.map((p) => [p.id, { ...p }]));
  const iMap = new Map(images.map((i) => [i.id, { ...i }]));

  const mapped = arr.map((o) => ({
    ...o,
    student: sMap.get(o.studentId) || null,
    product: pMap.get(o.productId) || null,
    deliveryImage: o.deliveryImage ? iMap.get(o.deliveryImage) || null : null,
  }));

  return Array.isArray(orders) ? mapped : mapped[0];
}

// Order'ni statusHistory bilan yuklab, ref'larni biriktiradi
async function loadOrder(id) {
  const order = await prisma.marketOrder.findUnique({
    where: { id },
    include: { statusHistory: { orderBy: { position: "asc" } } },
  });
  if (!order) return null;
  return attachOrderRefs(order);
}

/**
 * Uploads product image files and creates image documents.
 */
const createProductImages = async (files, uploadedBy) => {
  const createdImages = [];

  try {
    for (const file of files) {
      const processedImage = await uploadImageWithVariants({
        buffer: file.buffer,
        mimeType: file.mimetype,
      });

      const image = await prisma.image.create({
        data: {
          uploadedBy,
          variants: processedImage.variants,
          extension: processedImage.extension,
          mimeType: processedImage.mimeType,
          originalName: file.originalname,
          originalSizeBytes: file.size,
        },
      });

      createdImages.push({ ...image });
    }

    return createdImages;
  } catch (error) {
    await Promise.allSettled(
      createdImages.map(async (image) => {
        await deleteImageVariants(image.variants);
        await prisma.image.delete({ where: { id: image.id } }).catch(() => {});
      }),
    );

    throw error;
  }
};

/**
 * Validates product payload fields.
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
 */
const createProduct = async (payload, files, ownerId) => {
  validateProductPayload(payload, false);

  if (!Array.isArray(files) || files.length < 1 || files.length > 3) {
    throw new Error("Mahsulot rasmlari 1 tadan 3 tagacha bo'lishi kerak");
  }

  const imageDocuments = await createProductImages(files, ownerId);

  const created = await prisma.marketProduct.create({
    data: {
      name: String(payload.name).trim(),
      description: String(payload.description || "").trim(),
      price: Number(payload.price),
      quantity: Number(payload.quantity),
      createdBy: ownerId,
      images: {
        create: imageDocuments.map((image, i) => ({ imageId: image.id, position: i })),
      },
    },
  });

  return getProductById(created.id, true);
};

// Mahsulotni images junction bilan yuklab tekislaydi + createdBy biriktiradi
async function loadProduct(id, { admin = false } = {}) {
  const product = await prisma.marketProduct.findUnique({
    where: { id },
    include: { images: { include: { image: true }, orderBy: { position: "asc" } } },
  });
  if (!product) return null;
  const flat = flattenProduct(product);
  return admin ? attachCreatedBy(flat) : flat;
}

/**
 * Returns paginated admin products list.
 */
const getAdminProducts = async ({ page = 1, limit = 12 } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 12);
  const skip = (pageNumber - 1) * limitNumber;

  const where = { isArchived: false };

  const [rows, totalItems] = await Promise.all([
    prisma.marketProduct.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNumber,
      include: { images: { include: { image: true }, orderBy: { position: "asc" } } },
    }),
    prisma.marketProduct.count({ where }),
  ]);

  const products = await Promise.all(rows.map((p) => attachCreatedBy(flattenProduct(p))));

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
 */
const getStudentProducts = async ({ page = 1, limit = 12 } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 12);
  const skip = (pageNumber - 1) * limitNumber;

  const where = { isActive: true, isArchived: false };

  const [rows, totalItems] = await Promise.all([
    prisma.marketProduct.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNumber,
      include: { images: { include: { image: true }, orderBy: { position: "asc" } } },
    }),
    prisma.marketProduct.count({ where }),
  ]);

  return {
    data: rows.map(flattenProduct),
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
 */
const getProductById = async (productId, isAdmin = false) => {
  const product = await prisma.marketProduct.findUnique({
    where: { id: productId },
    include: { images: { include: { image: true }, orderBy: { position: "asc" } } },
  });

  if (!product || (!isAdmin && (!product.isActive || product.isArchived))) {
    throw new Error("Mahsulot topilmadi");
  }

  const flat = flattenProduct(product);
  return isAdmin ? attachCreatedBy(flat) : flat;
};

/**
 * Updates product fields and image set.
 */
const updateProduct = async (productId, payload, files, ownerId) => {
  validateProductPayload(payload, true);

  const product = await prisma.marketProduct.findFirst({
    where: { id: productId, isArchived: false },
    include: { images: { include: { image: true }, orderBy: { position: "asc" } } },
  });

  if (!product) {
    throw new Error("Mahsulot topilmadi");
  }

  const currentImages = product.images.map((pi) => ({ ...pi.image }));

  const removeImageIds = Array.isArray(payload.removeImageIds)
    ? payload.removeImageIds
    : [];
  const normalizedRemoveIds = removeImageIds.map((id) => String(id));

  const existingImageIds = currentImages.map((image) => String(image.id));
  const invalidRemoveId = normalizedRemoveIds.find(
    (id) => !existingImageIds.includes(id),
  );

  if (invalidRemoveId) {
    throw new Error("Noto'g'ri rasm identifikatori yuborildi");
  }

  if (Array.isArray(files) && files.length > 3) {
    throw new Error("Maksimal 3 ta rasm yuklash mumkin");
  }

  const preservedImageDocs = currentImages.filter(
    (image) => !normalizedRemoveIds.includes(String(image.id)),
  );
  const removedImageDocs = currentImages.filter((image) =>
    normalizedRemoveIds.includes(String(image.id)),
  );

  const newImageDocs = files?.length
    ? await createProductImages(files, ownerId)
    : [];

  const totalImages = preservedImageDocs.length + newImageDocs.length;
  if (totalImages < 1 || totalImages > 3) {
    throw new Error("Mahsulot rasmlari 1 tadan 3 tagacha bo'lishi kerak");
  }

  const data = {};
  if (payload.name !== undefined) data.name = String(payload.name).trim();
  if (payload.description !== undefined)
    data.description = String(payload.description || "").trim();
  if (payload.price !== undefined) data.price = Number(payload.price);
  if (payload.quantity !== undefined) data.quantity = Number(payload.quantity);
  if (payload.isActive !== undefined) {
    data.isActive =
      payload.isActive === true || String(payload.isActive) === "true";
  }

  const nextImages = [...preservedImageDocs, ...newImageDocs];

  await prisma.$transaction([
    prisma.marketProduct.update({ where: { id: productId }, data }),
    prisma.marketProductImage.deleteMany({ where: { productId } }),
    prisma.marketProductImage.createMany({
      data: nextImages.map((image, i) => ({ productId, imageId: image.id, position: i })),
      skipDuplicates: true,
    }),
  ]);

  if (removedImageDocs.length > 0) {
    await Promise.allSettled(
      removedImageDocs.map(async (image) => {
        await deleteImageVariants(image.variants);
        await prisma.image.delete({ where: { id: image.id } }).catch(() => {});
      }),
    );
  }

  return getProductById(productId, true);
};

/**
 * Soft deletes a product.
 */
const deleteProduct = async (productId) => {
  const product = await prisma.marketProduct.findFirst({
    where: { id: productId, isArchived: false },
  });

  if (!product) {
    throw new Error("Mahsulot topilmadi");
  }

  const updated = await prisma.marketProduct.update({
    where: { id: productId },
    data: { isArchived: true, isActive: false, archivedAt: new Date() },
  });

  return { ...updated };
};

/**
 * Creates purchase transaction document.
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
  await prisma.coinTransaction.create({
    data: {
      studentId,
      amount: totalPrice,
      type: "market_purchase",
      description: `Marketdan mahsulot buyurtma qilindi: -${totalPrice} coin`,
      balanceAfter,
      meta: { orderId, productId, quantity, unitPrice, totalPrice },
      date: new Date(),
    },
  });
};

/**
 * Creates refund transaction document.
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
  await prisma.coinTransaction.create({
    data: {
      studentId,
      amount: totalPrice,
      type: "market_refund",
      description: `Market buyurtmasi uchun qaytarim: +${totalPrice} coin (${reason})`,
      balanceAfter,
      meta: { orderId, productId, quantity, unitPrice, totalPrice },
      date: new Date(),
    },
  });
};

/**
 * Places a student order for product.
 */
const createOrder = async (studentId, payload) => {
  const quantity = Number(payload.quantity);

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Buyurtma soni kamida 1 bo'lishi kerak");
  }

  // Jarima bali 3 dan yuqori bo'lsa do'kondan foydalanish cheklangan
  const student = await prisma.user.findUnique({
    where: { id: studentId },
    select: { penaltyPoints: true },
  });
  if (student && student.penaltyPoints > 3) {
    throw new Error("Jarima balingiz 3 dan yuqori. Do'kondan foydalanish cheklangan.");
  }

  const product = await prisma.marketProduct.findFirst({
    where: { id: payload.productId, isActive: true, isArchived: false },
    include: { images: { include: { image: true }, orderBy: { position: "asc" } } },
  });

  if (!product) {
    throw new Error("Mahsulot topilmadi yoki faol emas");
  }

  if (product.quantity < quantity) {
    throw new Error("Omborda yetarli mahsulot mavjud emas");
  }

  const flatProduct = flattenProduct(product);
  const totalPrice = Number(product.price) * quantity;

  // Atomik coin yechish (balans yetsa)
  const debit = await prisma.user.updateMany({
    where: { id: studentId, role: "student", coinBalance: { gte: totalPrice } },
    data: { coinBalance: { decrement: totalPrice } },
  });
  if (debit.count === 0) {
    throw new Error("Coin yetarli emas");
  }
  const updatedStudent = await prisma.user.findUnique({
    where: { id: studentId },
    select: { coinBalance: true },
  });

  // Atomik ombor kamaytirish
  const stock = await prisma.marketProduct.updateMany({
    where: { id: product.id, isArchived: false, isActive: true, quantity: { gte: quantity } },
    data: { quantity: { decrement: quantity } },
  });
  if (stock.count === 0) {
    // rollback coin
    await prisma.user.update({
      where: { id: studentId },
      data: { coinBalance: { increment: totalPrice } },
    });
    throw new Error("Omborda yetarli mahsulot qolmagan");
  }

  const createdOrder = await prisma.marketOrder.create({
    data: {
      studentId,
      productId: product.id,
      quantity,
      unitPrice: Number(product.price),
      totalPrice,
      productSnapshot: {
        name: product.name,
        description: product.description || "",
        imageUrl: getProductCoverImageUrl(flatProduct),
      },
      statusHistory: {
        create: {
          status: "pending",
          changedBy: studentId,
          note: "Buyurtma yaratildi",
          changedAt: new Date(),
          position: 0,
        },
      },
    },
  });

  await createPurchaseTransaction({
    orderId: createdOrder.id,
    studentId,
    productId: product.id,
    quantity,
    totalPrice,
    unitPrice: Number(product.price),
    balanceAfter: updatedStudent.coinBalance,
  });

  return loadOrder(createdOrder.id);
};

/**
 * Applies order refund and stock rollback.
 */
const applyRefundAndRollback = async (order, reason) => {
  await prisma.marketProduct.update({
    where: { id: order.productId },
    data: { quantity: { increment: order.quantity } },
  });

  await prisma.user.update({
    where: { id: order.studentId },
    data: { coinBalance: { increment: order.totalPrice } },
  });
  const updatedStudent = await prisma.user.findUnique({
    where: { id: order.studentId },
    select: { coinBalance: true },
  });

  await createRefundTransaction({
    reason,
    orderId: order.id,
    studentId: order.studentId,
    productId: order.productId,
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    totalPrice: order.totalPrice,
    balanceAfter: updatedStudent.coinBalance,
  });

  return updatedStudent;
};

/**
 * Cancels order by student.
 */
const cancelOrderByStudent = async (orderId, studentId) => {
  const order = await prisma.marketOrder.findFirst({
    where: { id: orderId, studentId },
  });

  if (!order) {
    throw new Error("Buyurtma topilmadi");
  }

  if (["delivering", "approved", "rejected"].includes(order.status)) {
    throw new Error("Ushbu buyurtmani bekor qilib bo'lmaydi");
  }

  if (order.status === "cancelled") {
    throw new Error("Buyurtma allaqachon bekor qilingan");
  }

  await applyRefundAndRollback(order, "o'quvchi tomonidan bekor qilindi");

  await prisma.marketOrder.update({
    where: { id: orderId },
    data: { status: "cancelled", rejectReason: "" },
  });

  return loadOrder(orderId);
};

// Buyurtmaga status tarixi qatorini qo'shadi (position count'dan)
async function appendStatusHistory(orderId, entry) {
  const count = await prisma.marketOrderStatusHistory.count({ where: { orderId } });
  await prisma.marketOrderStatusHistory.create({
    data: { orderId, ...entry, position: count },
  });
}

/**
 * Updates order status by owner.
 */
const updateOrderStatusByOwner = async (orderId, payload, ownerId, file = null) => {
  const status = String(payload.status || "").trim();
  const rejectReason = String(payload.rejectReason || "").trim();

  if (!["delivering", "approved", "rejected"].includes(status)) {
    throw new Error("Noto'g'ri status yuborildi");
  }

  const order = await prisma.marketOrder.findUnique({ where: { id: orderId } });

  if (!order) {
    throw new Error("Buyurtma topilmadi");
  }

  if (status === "delivering" || status === "rejected") {
    if (order.status !== "pending") {
      throw new Error("Faqat kutilayotgan buyurtma holatini o'zgartirish mumkin");
    }
  }

  if (status === "approved") {
    if (order.status !== "delivering") {
      throw new Error("Faqat yetkazilmoqda holatidagi buyurtmani yetkazib berildi deb belgilash mumkin");
    }
  }

  if (status === "rejected" && rejectReason.length < 3) {
    throw new Error("Rad etish sababi majburiy");
  }

  const data = {
    status,
    rejectReason: status === "rejected" ? rejectReason : order.rejectReason,
  };

  if (status === "rejected") {
    await applyRefundAndRollback(order, "owner tomonidan rad etildi");
  }

  if (status === "approved" && file) {
    const processedImage = await uploadImageWithVariants({
      buffer: file.buffer,
      mimeType: file.mimetype,
    });

    const image = await prisma.image.create({
      data: {
        uploadedBy: ownerId,
        variants: processedImage.variants,
        extension: processedImage.extension,
        mimeType: processedImage.mimeType,
        originalName: file.originalname,
        originalSizeBytes: file.size,
      },
    });

    data.deliveryImage = image.id;
  }

  const noteMap = {
    delivering: "Buyurtma yetkazilmoqda",
    approved: "Buyurtma yetkazib berildi",
    rejected: rejectReason,
  };

  await prisma.marketOrder.update({ where: { id: orderId }, data });
  await appendStatusHistory(orderId, {
    status,
    changedBy: ownerId,
    note: noteMap[status] || "",
    changedAt: new Date(),
  });

  return loadOrder(orderId);
};

/**
 * Adds or replaces delivery image on an approved order.
 */
const addDeliveryImageByOwner = async (orderId, file, ownerId) => {
  if (!file) {
    throw new Error("Rasm majburiy");
  }

  const order = await prisma.marketOrder.findUnique({ where: { id: orderId } });

  if (!order) {
    throw new Error("Buyurtma topilmadi");
  }

  if (order.status !== "approved") {
    throw new Error("Faqat yetkazib berilgan buyurtmaga rasm qo'shish mumkin");
  }

  const oldImage = order.deliveryImage
    ? await prisma.image.findUnique({ where: { id: order.deliveryImage } })
    : null;

  const processedImage = await uploadImageWithVariants({
    buffer: file.buffer,
    mimeType: file.mimetype,
  });

  const image = await prisma.image.create({
    data: {
      uploadedBy: ownerId,
      variants: processedImage.variants,
      extension: processedImage.extension,
      mimeType: processedImage.mimeType,
      originalName: file.originalname,
      originalSizeBytes: file.size,
    },
  });

  await prisma.marketOrder.update({
    where: { id: orderId },
    data: { deliveryImage: image.id },
  });

  if (oldImage) {
    await deleteImageVariants(oldImage.variants);
    await prisma.image.delete({ where: { id: oldImage.id } }).catch(() => {});
  }

  return loadOrder(orderId);
};

/**
 * Returns paginated admin orders list.
 */
const getAdminOrders = async ({ page = 1, limit = 20, status = "", productId = "" } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 20);
  const skip = (pageNumber - 1) * limitNumber;

  const where = {};
  if (["pending", "delivering", "approved", "rejected", "cancelled"].includes(status)) {
    where.status = status;
  }
  if (productId) {
    where.productId = productId;
  }

  const [rows, totalItems] = await Promise.all([
    prisma.marketOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNumber,
      include: { statusHistory: { orderBy: { position: "asc" } } },
    }),
    prisma.marketOrder.count({ where }),
  ]);

  const orders = await attachOrderRefs(rows);

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
 */
const getStudentOrders = async (studentId, { page = 1, limit = 20 } = {}) => {
  const pageNumber = parsePositiveInt(page, 1);
  const limitNumber = parsePositiveInt(limit, 20);
  const skip = (pageNumber - 1) * limitNumber;

  const where = { studentId };

  const [rows, totalItems] = await Promise.all([
    prisma.marketOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNumber,
      include: { statusHistory: { orderBy: { position: "asc" } } },
    }),
    prisma.marketOrder.count({ where }),
  ]);

  const orders = await attachOrderRefs(rows);

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
 * Returns order statistics for a specific product.
 */
const getProductStats = async (productId, { days, startDate: qStartDate, endDate: qEndDate } = {}) => {
  let rangeEnd = new Date();
  rangeEnd.setHours(23, 59, 59, 999);

  let rangeStart;
  if (qStartDate) {
    rangeStart = new Date(qStartDate);
    rangeStart.setHours(0, 0, 0, 0);
  } else {
    const daysNum = parsePositiveInt(days, 30);
    rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - daysNum);
    rangeStart.setHours(0, 0, 0, 0);
  }

  if (qEndDate) {
    rangeEnd = new Date(qEndDate);
    rangeEnd.setHours(23, 59, 59, 999);
  }

  const diffDays = Math.ceil((rangeEnd - rangeStart) / (1000 * 60 * 60 * 24));
  let groupBy;
  if (diffDays <= 90) groupBy = "day";
  else if (diffDays <= 365) groupBy = "week";
  else groupBy = "month";

  // Postgres TO_CHAR format ($dateToString ekvivalenti)
  let dateFmt;
  if (groupBy === "month") dateFmt = "YYYY-MM";
  else if (groupBy === "week") dateFmt = 'IYYY-"W"IW';
  else dateFmt = "YYYY-MM-DD";

  const [byStatusRaw, trendsRaw] = await Promise.all([
    prisma.marketOrder.groupBy({
      by: ["status"],
      where: { productId, createdAt: { gte: rangeStart, lte: rangeEnd } },
      _count: { _all: true },
      _sum: { totalPrice: true, quantity: true },
    }),
    prisma.$queryRawUnsafe(
      `SELECT TO_CHAR(created_at, $1) AS date,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM market_orders
       WHERE product_id = $2 AND created_at >= $3 AND created_at <= $4
       GROUP BY 1
       ORDER BY 1`,
      dateFmt,
      productId,
      rangeStart,
      rangeEnd,
    ),
  ]);

  const allStatuses = ["pending", "delivering", "approved", "rejected", "cancelled"];
  const statusMap = {};
  byStatusRaw.forEach((s) => {
    statusMap[s.status] = {
      count: s._count._all,
      coins: s._sum.totalPrice || 0,
      quantity: s._sum.quantity || 0,
    };
  });

  const byStatus = allStatuses.map((status) => ({
    status,
    count: statusMap[status]?.count || 0,
    coins: statusMap[status]?.coins || 0,
    quantity: statusMap[status]?.quantity || 0,
  }));

  const summary = byStatus.reduce(
    (acc, s) => {
      acc.total += s.count;
      acc.totalCoins += s.coins;
      acc.totalQuantity += s.quantity;
      return acc;
    },
    { total: 0, totalCoins: 0, totalQuantity: 0 },
  );

  return { summary, byStatus, trends: trendsRaw, groupBy };
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
  getProductStats,
  cancelOrderByStudent,
  updateOrderStatusByOwner,
  addDeliveryImageByOwner,
};
