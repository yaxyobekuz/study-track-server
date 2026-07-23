const prisma = require("../config/prisma");
const XLSX = require("xlsx");
const { BadRequestError, NotFoundError } = require("../utils/errors");

/**
 * Excel fayldan mavzularni yuklash.
 * @param {string|null} subjectId - bitta fan uchun ID (ixtiyoriy)
 * @param {object} file - yuklangan fayl (multer fayl obyekti)
 * @param {string} createdBy - yaratuvchi foydalanuvchi ID
 * @returns {Promise<{processedSubjects: number, totalTopics: number, errors: Array}>}
 */
async function uploadTopics(subjectId, file, createdBy) {
  if (!file) {
    throw new BadRequestError("Excel fayl yuklanmadi");
  }

  const fileExtension = file.originalname.split(".").pop().toLowerCase();
  if (fileExtension !== "xlsx") {
    throw new BadRequestError("Faqat .xlsx formatdagi fayllar qabul qilinadi");
  }

  const workbook = XLSX.read(file.buffer, { type: "buffer" });
  const sheetNames = workbook.SheetNames;

  if (sheetNames.length === 0) {
    throw new BadRequestError("Excel faylda sahifalar topilmadi");
  }

  let processedSubjects = 0;
  let totalTopics = 0;
  const errors = [];

  if (subjectId) {
    const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) {
      throw new NotFoundError("Fan topilmadi");
    }

    const sheetName = sheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      throw new BadRequestError("Excel faylda ma'lumot topilmadi");
    }

    const topics = [];
    for (let index = 0; index < data.length; index++) {
      const row = data[index];
      const keys = Object.keys(row);
      const name = row[keys[1]];
      const description = row[keys[2]] || "";
      const order = index + 1;

      if (!name) {
        errors.push(
          `Sahifa "${sheetName}": Qator ${index + 2} - Mavzu nomi topilmadi`,
        );
        continue;
      }

      topics.push({
        subjectId,
        order,
        name: String(name).trim(),
        description: String(description).trim(),
        createdBy,
      });
    }

    if (topics.length === 0) {
      throw new BadRequestError("Excel faylda to'g'ri formatdagi mavzular topilmadi");
    }

    await prisma.topic.deleteMany({ where: { subjectId } });
    await prisma.topic.createMany({ data: topics });

    processedSubjects = 1;
    totalTopics = topics.length;
  } else {
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);

      if (data.length === 0) {
        errors.push(`Sahifa "${sheetName}": Ma'lumot topilmadi`);
        continue;
      }

      const subject = await prisma.subject.findFirst({
        where: { name: { equals: sheetName, mode: "insensitive" } },
      });

      if (!subject) {
        errors.push(`Sahifa "${sheetName}": Bu nomli fan bazada topilmadi`);
        continue;
      }

      const topics = [];
      for (let index = 0; index < data.length; index++) {
        const row = data[index];
        const keys = Object.keys(row);
        const name = row[keys[1]];
        const description = row[keys[2]] || "";
        const order = index + 1;

        if (!name) {
          errors.push(
            `Sahifa "${sheetName}": Qator ${index + 2} - Mavzu nomi topilmadi`,
          );
          continue;
        }

        topics.push({
          subjectId: subject.id,
          order,
          name: String(name).trim(),
          description: String(description).trim(),
          createdBy,
        });
      }

      if (topics.length > 0) {
        await prisma.topic.deleteMany({ where: { subjectId: subject.id } });
        await prisma.topic.createMany({ data: topics });

        processedSubjects++;
        totalTopics += topics.length;
      }
    }
  }

  if (processedSubjects === 0) {
    throw new BadRequestError("Hech qanday mavzu yuklanmadi");
  }

  return {
    processedSubjects,
    totalTopics,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Berilgan fan uchun barcha mavzularni olish.
 * @param {string} subjectId - fan ID
 * @returns {Promise<Array>} mavzular ro'yxati
 */
async function getTopicsBySubject(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  return prisma.topic.findMany({
    where: { subjectId },
    orderBy: { order: "asc" },
    omit: { createdBy: true },
  });
}

/**
 * Berilgan fan uchun barcha mavzularni o'chirish.
 * @param {string} subjectId - fan ID
 * @returns {Promise<{deletedCount: number}>}
 */
async function deleteTopicsBySubject(subjectId) {
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  if (!subject) {
    throw new NotFoundError("Fan topilmadi");
  }

  const result = await prisma.topic.deleteMany({ where: { subjectId } });
  return { deletedCount: result.count };
}

module.exports = {
  uploadTopics,
  getTopicsBySubject,
  deleteTopicsBySubject,
};
