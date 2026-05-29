const Question = require("../models/question.model");
const Test = require("../models/test.model");
const { uploadFile } = require("./file.service");
const { deleteObject } = require("./fileStorage.service");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

/**
 * Multer fayllarini DO Spaces ga yuklaydi va attachment obyektlarini qaytaradi.
 * Xatolik bo'lsa allaqachon yuklangan fayllarni tozalaydi.
 */
async function _uploadImages(files) {
  if (!files || files.length === 0) return [];
  const uploaded = [];
  try {
    for (const file of files) {
      const result = await uploadFile({
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
      });
      uploaded.push(result);
    }
    return uploaded;
  } catch (error) {
    await Promise.allSettled(
      uploaded.map((attachment) => deleteObject(attachment.key)),
    );
    throw error;
  }
}

async function _deleteImages(attachments) {
  const valid = (attachments || []).filter((a) => a && a.key);
  if (valid.length === 0) return;
  await Promise.allSettled(valid.map((a) => deleteObject(a.key)));
}

/**
 * imageMap asosida yuklangan fayllarni savol va variantlarga biriktiradi.
 * Format: { question: <fileIndex>, options: { <optionIndex>: <fileIndex> } }
 */
function _applyImageMap(imageMap, uploaded) {
  const result = { questionImage: null, optionImages: {} };
  if (!imageMap) return result;

  let map = imageMap;
  if (typeof map === "string") {
    try {
      map = JSON.parse(map);
    } catch {
      throw new BadRequestError("imageMap noto'g'ri formatda");
    }
  }

  if (map.question !== undefined && map.question !== null) {
    const att = uploaded[map.question];
    if (!att) throw new BadRequestError("Savol rasmi topilmadi");
    result.questionImage = att;
  }

  if (map.options && typeof map.options === "object") {
    for (const [optIndex, fileIndex] of Object.entries(map.options)) {
      const att = uploaded[fileIndex];
      if (!att) {
        throw new BadRequestError(`${optIndex}-variant rasmi topilmadi`);
      }
      result.optionImages[optIndex] = att;
    }
  }

  return result;
}

/**
 * Test muallifligini tekshirib testni qaytaradi.
 */
async function _loadTestOwned(testId, teacherId) {
  const test = await Test.findById(testId);
  if (!test || !test.isActive) {
    throw new NotFoundError("Test topilmadi");
  }
  if (test.teacher.toString() !== teacherId.toString()) {
    throw new ForbiddenError("Bu test sizga tegishli emas");
  }
  return test;
}

/**
 * Testning barcha (faol) savollarini order bo'yicha qaytaradi.
 * Pagination yo'q — bitta testda odatda < 100 savol.
 */
async function listQuestionsForTest(testId, teacherId) {
  await _loadTestOwned(testId, teacherId);
  return Question.find({ test: testId, isActive: true }).sort({
    order: 1,
    createdAt: 1,
  });
}

/**
 * Test ichida yangi savol yaratadi.
 */
async function createQuestion(testId, data, files, teacherId) {
  const test = await _loadTestOwned(testId, teacherId);

  const { type, text, points } = data;
  if (!type) throw new BadRequestError("Savol turi majburiy");
  if (points === undefined || points === null || points === "") {
    throw new BadRequestError("Savol balli majburiy");
  }

  let options = data.options || [];
  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      throw new BadRequestError("Variantlar noto'g'ri formatda");
    }
  }

  const uploaded = await _uploadImages(files);

  try {
    const { questionImage, optionImages } = _applyImageMap(
      data.imageMap,
      uploaded,
    );

    // order = mavjud savollar soni + 1
    const existingCount = await Question.countDocuments({
      test: test._id,
      isActive: true,
    });

    const questionDoc = {
      test: test._id,
      type,
      text: text || undefined,
      image: questionImage,
      points: Number(points),
      options: [],
      order: existingCount + 1,
    };

    if (type === "standard") {
      questionDoc.options = options.map((opt, index) => ({
        text: opt.text || undefined,
        image: optionImages[index] || null,
        isCorrect: Boolean(opt.isCorrect),
      }));
    }

    const question = await Question.create(questionDoc);
    return question;
  } catch (error) {
    await _deleteImages(uploaded);
    throw error;
  }
}

/**
 * Savolni tahrirlaydi. Tur o'zgartirilgan bo'lsa variantlar tozalanadi/yangilanadi.
 */
async function updateQuestion(id, data, files, teacherId) {
  const question = await Question.findById(id);
  if (!question || !question.isActive) {
    throw new NotFoundError("Savol topilmadi");
  }
  // Test orqali muallifligini tekshirish
  await _loadTestOwned(question.test, teacherId);

  const { type, text, points } = data;

  let options = data.options;
  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      throw new BadRequestError("Variantlar noto'g'ri formatda");
    }
  }

  const uploaded = await _uploadImages(files);
  const oldImages = [];

  try {
    const { questionImage, optionImages } = _applyImageMap(
      data.imageMap,
      uploaded,
    );

    if (text !== undefined) question.text = text || undefined;
    if (points !== undefined) question.points = Number(points);
    if (type !== undefined) question.type = type;

    if (questionImage) {
      if (question.image) oldImages.push(question.image);
      question.image = questionImage;
    } else if (data.removeQuestionImage === "true") {
      if (question.image) oldImages.push(question.image);
      question.image = null;
    }

    // Variantlar - faqat standard turida; turni open ga o'zgartirilsa tozalanadi
    if (question.type === "open") {
      // Eski variantlardagi rasmlarni belgilash
      (question.options || []).forEach((opt) => {
        if (opt.image) oldImages.push(opt.image);
      });
      question.options = [];
    } else if (options !== undefined) {
      // Eski variant rasmlari (yangilari almashtiriladi)
      (question.options || []).forEach((opt) => {
        if (opt.image) oldImages.push(opt.image);
      });
      question.options = options.map((opt, index) => ({
        text: opt.text || undefined,
        image:
          optionImages[index] ||
          (opt.image && opt.image.key ? opt.image : null),
        isCorrect: Boolean(opt.isCorrect),
      }));
    }

    await question.save();
    await _deleteImages(oldImages);

    return question;
  } catch (error) {
    await _deleteImages(uploaded);
    throw error;
  }
}

/**
 * Savolni o'chiradi (soft delete).
 * Sessiya snapshot'idagi nusxa tegmaydi.
 */
async function deactivateQuestion(id, teacherId) {
  const question = await Question.findById(id);
  if (!question || !question.isActive) {
    throw new NotFoundError("Savol topilmadi");
  }
  await _loadTestOwned(question.test, teacherId);

  question.isActive = false;
  await question.save();
}

/**
 * Testning savollarini berilgan tartibda qayta tartiblaydi.
 * orderedIds: [questionId, ...] - yangi tartibga ko'ra.
 */
async function reorderQuestions(testId, orderedIds, teacherId) {
  await _loadTestOwned(testId, teacherId);

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new BadRequestError("Tartiblanish ro'yxati bo'sh");
  }

  // Berilgan ID'lar shu testga tegishli ekanligini tekshirish
  const questions = await Question.find({
    _id: { $in: orderedIds },
    test: testId,
    isActive: true,
  });

  if (questions.length !== orderedIds.length) {
    throw new BadRequestError(
      "Tartiblanish ro'yxatida noto'g'ri yoki begona savol bor",
    );
  }

  // Batch update - har savolga yangi order
  await Promise.all(
    orderedIds.map((qid, index) =>
      Question.updateOne({ _id: qid }, { $set: { order: index + 1 } }),
    ),
  );
}

module.exports = {
  listQuestionsForTest,
  createQuestion,
  updateQuestion,
  deactivateQuestion,
  reorderQuestions,
};
