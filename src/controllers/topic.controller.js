// Models
const Topic = require("../models/topic.model");
const Subject = require("../models/subject.model");

// Excel parser
const XLSX = require("xlsx");

/**
 * Upload Excel file with topics
 * @route POST /api/topics/upload
 * @access Owner only
 */
const uploadTopics = async (req, res) => {
  try {
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Excel fayl yuklanmadi",
      });
    }

    // Validate file extension
    const fileExtension = req.file.originalname.split(".").pop().toLowerCase();
    if (fileExtension !== "xlsx") {
      return res.status(400).json({
        success: false,
        message: "Faqat .xlsx formatdagi fayllar qabul qilinadi",
      });
    }

    // Get subjectId from query/body if single-subject upload
    const singleSubjectId = req.body.subjectId || req.query.subjectId;

    // Read Excel file
    const workbook = XLSX.readFile(req.file.path);
    const sheetNames = workbook.SheetNames;

    if (sheetNames.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Excel faylda sahifalar topilmadi",
      });
    }

    let processedSubjects = 0;
    let totalTopics = 0;
    const errors = [];

    // If single subject mode
    if (singleSubjectId) {
      // Verify subject exists
      const subject = await Subject.findById(singleSubjectId);
      if (!subject) {
        return res.status(404).json({
          success: false,
          message: "Fan topilmadi",
        });
      }

      // Use first sheet
      const sheetName = sheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet);

      if (data.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Excel faylda ma'lumot topilmadi",
        });
      }

      // Parse topics
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
          subject: singleSubjectId,
          order,
          name: String(name).trim(),
          description: String(description).trim(),
          createdBy: req.user._id,
        });
      }

      if (topics.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Excel faylda to'g'ri formatdagi mavzular topilmadi",
          errors,
        });
      }

      // Delete existing topics for this subject
      await Topic.deleteMany({ subject: singleSubjectId });

      // Insert new topics
      await Topic.insertMany(topics);

      processedSubjects = 1;
      totalTopics = topics.length;
    } else {
      // Multi-subject mode - each sheet is a subject
      for (const sheetName of sheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);

        if (data.length === 0) {
          errors.push(`Sahifa "${sheetName}": Ma'lumot topilmadi`);
          continue;
        }

        // Find subject by name (case-insensitive)
        const subject = await Subject.findOne({
          name: new RegExp(`^${sheetName}$`, "i"),
        });

        if (!subject) {
          errors.push(`Sahifa "${sheetName}": Bu nomli fan bazada topilmadi`);
          continue;
        }

        // Parse topics
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
            subject: subject._id,
            order,
            name: String(name).trim(),
            description: String(description).trim(),
            createdBy: req.user._id,
          });
        }

        if (topics.length > 0) {
          // Delete existing topics for this subject
          await Topic.deleteMany({ subject: subject._id });

          // Insert new topics
          await Topic.insertMany(topics);

          processedSubjects++;
          totalTopics += topics.length;
        }
      }
    }

    if (processedSubjects === 0) {
      return res.status(400).json({
        success: false,
        message: "Hech qanday mavzu yuklanmadi",
        errors,
      });
    }

    res.status(200).json({
      success: true,
      message: `Muvaffaqiyatli yuklandi: ${processedSubjects} ta fan, ${totalTopics} ta mavzu`,
      data: {
        processedSubjects,
        totalTopics,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    console.error("Upload topics error:", error);
    res.status(500).json({
      success: false,
      message: "Excel faylni yuklashda xatolik yuz berdi",
      error: error.message,
    });
  }
};

/**
 * Get all topics for a subject
 * @route GET /api/topics/subject/:id
 * @access Protected
 */
const getTopicsBySubject = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify subject exists
    const subject = await Subject.findById(id);
    if (!subject) {
      return res.status(404).json({
        success: false,
        message: "Fan topilmadi",
      });
    }

    const topics = await Topic.find({ subject: id })
      .sort({ order: 1 })
      .select("-createdBy");

    res.status(200).json({
      success: true,
      data: topics,
      count: topics.length,
    });
  } catch (error) {
    console.error("Get topics by subject error:", error);
    res.status(500).json({
      success: false,
      message: "Mavzularni olishda xatolik yuz berdi",
    });
  }
};

/**
 * Delete all topics for a subject
 * @route DELETE /api/topics/subject/:id
 * @access Owner only
 */
const deleteTopicsBySubject = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify subject exists
    const subject = await Subject.findById(id);
    if (!subject) {
      return res.status(404).json({
        success: false,
        message: "Fan topilmadi",
      });
    }

    const result = await Topic.deleteMany({ subject: id });

    res.status(200).json({
      success: true,
      message: `${result.deletedCount} ta mavzu o'chirildi`,
      data: {
        deletedCount: result.deletedCount,
      },
    });
  } catch (error) {
    console.error("Delete topics by subject error:", error);
    res.status(500).json({
      success: false,
      message: "Mavzularni o'chirishda xatolik yuz berdi",
    });
  }
};

module.exports = {
  uploadTopics,
  getTopicsBySubject,
  deleteTopicsBySubject,
};
