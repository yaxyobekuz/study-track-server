const asyncHandler = require("../middleware/async.middleware");
const aiService = require("../services/ai.service");
const questionService = require("../services/question.service");
const { BadRequestError } = require("../utils/errors");

/**
 * AI yordamida savollar generatsiya qilib testga qo'shadi (multipart).
 * POST /api/tests/:testId/questions/ai-generate
 *
 * Body: { source: "prompt" | "images", prompt, count, difficulty, type }
 * Files (ixtiyoriy, "files" maydoni): faqat rasm (Vision).
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

  if (source === "images") {
    // Faqat rasmlar (Vision uchun)
    const images = files
      .filter((file) => file.mimetype.startsWith("image/"))
      .map((file) => ({ buffer: file.buffer, mimeType: file.mimetype }));

    if (images.length === 0) {
      throw new BadRequestError("Kamida bitta rasm yuklang");
    }

    questions = await aiService.generateFromImages({
      images,
      prompt,
      count,
      difficulty,
      type,
    });
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
