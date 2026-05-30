const asyncHandler = require("../middleware/async.middleware");
const aiService = require("../services/ai.service");
const questionService = require("../services/question.service");
const {
  extractTextFromBuffer,
  isExtractableTextMime,
  isImageMime,
} = require("../helpers/fileTextExtractor.helper");
const { BadRequestError } = require("../utils/errors");

/**
 * AI yordamida savollar generatsiya qilib testga qo'shadi (multipart).
 * POST /api/tests/:testId/questions/ai-generate
 *
 * Body: { source: "prompt" | "files", prompt, count, difficulty, type }
 * Files (ixtiyoriy, "files" maydoni): rasm / PDF / Word / matn.
 */
const generateQuestions = asyncHandler(async (req, res) => {
  const { testId } = req.params;
  const {
    source = "prompt",
    prompt = "",
    count = 5,
    difficulty = "medium",
    type = "standard",
  } = req.body;

  const files = req.files || [];

  let questions = [];

  if (source === "files") {
    if (files.length === 0) {
      throw new BadRequestError("Kamida bitta fayl yuklang");
    }

    // Rasmlarni Vision uchun, matnli fayllardan matn ajratamiz
    const images = [];
    const textParts = [];

    for (const file of files) {
      if (isImageMime(file.mimetype)) {
        images.push({ buffer: file.buffer, mimeType: file.mimetype });
      } else if (isExtractableTextMime(file.mimetype)) {
        const text = await extractTextFromBuffer({
          buffer: file.buffer,
          mimeType: file.mimetype,
        });
        if (text) textParts.push(text);
      }
    }

    const extractedText = textParts.join("\n\n");

    if (images.length === 0 && !extractedText) {
      throw new BadRequestError(
        "Yuklangan fayllardan matn yoki rasm topilmadi",
      );
    }

    if (images.length > 0) {
      questions = await aiService.generateFromImages({
        images,
        prompt,
        extractedText,
        count,
        difficulty,
        type,
      });
    } else {
      questions = await aiService.generateFromText({
        extractedText,
        prompt,
        count,
        difficulty,
        type,
      });
    }
  } else {
    // source === "prompt"
    if (!prompt || !prompt.trim()) {
      throw new BadRequestError("Mavzu yoki ko'rsatma kiriting");
    }
    questions = await aiService.generateFromPrompt({
      prompt,
      count,
      difficulty,
      type,
    });
  }

  if (questions.length === 0) {
    throw new BadRequestError(
      "AI savol generatsiya qila olmadi. Boshqa material yoki ko'rsatma bilan urinib ko'ring.",
    );
  }

  const result = await questionService.bulkCreateQuestions(
    testId,
    questions,
    req.user._id,
  );

  res.status(201).json({
    success: true,
    data: result,
  });
});

module.exports = {
  generateQuestions,
};
