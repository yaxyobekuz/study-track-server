const Question = require("../models/question.model");
const Test = require("../models/test.model");
const { uploadFile } = require("./file.service");
const { deleteObject } = require("./fileStorage.service");
const { DIFFICULTY_VALUES } = require("../helpers/scoring.helper");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

/** Qiyinlik darajasini tekshiradi (noto'g'ri/bo'sh bo'lsa - "medium"). */
function _normalizeDifficulty(difficulty) {
  return DIFFICULTY_VALUES.includes(difficulty) ? difficulty : "medium";
}

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
 * Pagination yo'q - bitta testda odatda < 100 savol.
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

  const { type, text, difficulty } = data;
  if (!type) throw new BadRequestError("Savol turi majburiy");

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
      difficulty: _normalizeDifficulty(difficulty),
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

  const { type, text, difficulty } = data;

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
    if (difficulty !== undefined) {
      question.difficulty = _normalizeDifficulty(difficulty);
    }
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
 * Bir nechta savolni (AI generatsiya natijasi) testga to'g'ridan-to'g'ri qo'shadi.
 * Faqat matnli savollar (rasmsiz) - AI rasm yaratmaydi.
 * Yaroqsiz savollar (pre-save validatsiyadan o'tmaganlar) skip qilinadi.
 * @param {string} testId Test ID.
 * @param {Array} questionsArray Normallashtirilgan savollar massivi.
 * @param {string} teacherId O'qituvchi ID (mualliflik tekshiruvi).
 * @returns {Promise<{ created: number, questions: Array }>} Yaratilganlar.
 */
async function bulkCreateQuestions(
  testId,
  questionsArray,
  teacherId,
  batchDifficulty,
) {
  const test = await _loadTestOwned(testId, teacherId);

  if (!Array.isArray(questionsArray) || questionsArray.length === 0) {
    throw new BadRequestError("Qo'shish uchun savollar yo'q");
  }

  let order = await Question.countDocuments({
    test: test._id,
    isActive: true,
  });

  const created = [];

  // insertMany pre("save") validatorni o'tkazib yuboradi - shuning uchun create loop.
  for (const q of questionsArray) {
    order += 1;
    try {
      const question = await Question.create({
        test: test._id,
        type: q.type,
        text: q.text || undefined,
        image: null,
        difficulty: _normalizeDifficulty(q.difficulty || batchDifficulty),
        options:
          q.type === "standard"
            ? (q.options || []).map((opt) => ({
                text: opt.text || undefined,
                image: null,
                isCorrect: Boolean(opt.isCorrect),
              }))
            : [],
        order,
      });
      created.push(question);
    } catch (error) {
      // Yaroqsiz savolni o'tkazib yuboramiz, lekin order ortmaydi
      order -= 1;
    }
  }

  return { created: created.length, questions: created };
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

  // Qolgan faol savollar tartibini 1..N qilib qayta normallashtirish (bo'shliqsiz)
  const remaining = await Question.find({
    test: question.test,
    isActive: true,
  }).sort({ order: 1, createdAt: 1 });
  await Promise.all(
    remaining.map((q, index) =>
      Question.updateOne({ _id: q._id }, { $set: { order: index + 1 } }),
    ),
  );
}

/**
 * Testning barcha faol savollarini o'chiradi (soft delete).
 * @param {string} testId Test ID.
 * @param {string} teacherId O'qituvchi ID (mualliflik tekshiruvi).
 * @returns {Promise<{ deleted: number }>} O'chirilganlar soni.
 */
async function deactivateAllQuestions(testId, teacherId) {
  await _loadTestOwned(testId, teacherId);

  const res = await Question.updateMany(
    { test: testId, isActive: true },
    { $set: { isActive: false } },
  );

  return { deleted: res.modifiedCount };
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
  bulkCreateQuestions,
  updateQuestion,
  deactivateQuestion,
  deactivateAllQuestions,
  reorderQuestions,
};
