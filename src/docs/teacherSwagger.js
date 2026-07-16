/**
 * Study-Track — O'qituvchi (Teacher) paneli uchun Swagger/OpenAPI spetsifikatsiyasi.
 *
 * MUHIM: Bu hujjatda FAQAT o'qituvchi (teacher) roli kira oladigan endpointlar bor.
 * Ya'ni:
 *   - roli aniq `teacher` ni o'z ichiga oladigan endpointlar, YOKI
 *   - har qanday tizimga kirgan foydalanuvchi (protect) ucha oladigan endpointlar,
 *   - hamda `POST /auth/login` (public).
 * Owner-only va student-only endpointlar bu yerga KIRITILMAGAN (teacher token
 * ularga 403 qaytaradi).
 *
 * Swagger UI: GET /api-docs
 * Baza URL:   http://localhost:7070/api
 */

// ---------------------------------------------------------------------------
// Qayta ishlatiladigan komponentlar (schemas)
// ---------------------------------------------------------------------------

const schemas = {
  // Umumiy javob konvertlari
  Error: {
    type: "object",
    properties: {
      success: { type: "boolean", example: false },
      message: { type: "string", example: "Xatolik yuz berdi" },
    },
  },
  Pagination: {
    type: "object",
    properties: {
      page: { type: "integer", example: 1 },
      limit: { type: "integer", example: 24 },
      total: { type: "integer", example: 120 },
      totalPages: { type: "integer", example: 5 },
      hasNextPage: { type: "boolean", example: true },
      hasPrevPage: { type: "boolean", example: false },
    },
  },

  // Auth
  LoginRequest: {
    type: "object",
    required: ["username", "password"],
    properties: {
      username: { type: "string", example: "teacher01" },
      password: { type: "string", format: "password", example: "parol123" },
    },
  },
  LoginResponse: {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              id: { type: "string", example: "665f1c2e8a1b2c3d4e5f6789" },
              username: { type: "string", example: "teacher01" },
              firstName: { type: "string", example: "Ali" },
              lastName: { type: "string", example: "Valiyev" },
              fullName: { type: "string", example: "Ali Valiyev" },
              role: { type: "string", example: "teacher" },
              classes: {
                type: "array",
                items: { $ref: "#/components/schemas/ClassRef" },
              },
            },
          },
          token: { type: "string", example: "eyJhbGciOiJIUzI1NiIsIn..." },
        },
      },
    },
  },

  // Umumiy referenslar (populate qilingan qisqa obyektlar)
  ClassRef: {
    type: "object",
    properties: {
      _id: { type: "string", example: "665f1c2e8a1b2c3d4e5f0001" },
      name: { type: "string", example: "10-A" },
    },
  },
  SubjectRef: {
    type: "object",
    properties: {
      _id: { type: "string", example: "665f1c2e8a1b2c3d4e5f0002" },
      name: { type: "string", example: "Matematika" },
    },
  },
  UserRef: {
    type: "object",
    properties: {
      _id: { type: "string" },
      firstName: { type: "string", example: "Ali" },
      lastName: { type: "string", example: "Valiyev" },
    },
  },

  // Foydalanuvchi (auth/me va o'quvchilar ro'yxati uchun)
  User: {
    type: "object",
    properties: {
      _id: { type: "string" },
      username: { type: "string", example: "teacher01" },
      firstName: { type: "string", example: "Ali" },
      lastName: { type: "string", example: "Valiyev" },
      fullName: { type: "string", example: "Ali Valiyev" },
      role: { type: "string", example: "teacher" },
      classes: {
        type: "array",
        items: { $ref: "#/components/schemas/ClassRef" },
      },
      penaltyPoints: { type: "number", example: 0 },
      coinBalance: { type: "number", example: 0 },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  // Sinf, fan, mavzu
  Class: {
    type: "object",
    properties: {
      _id: { type: "string" },
      name: { type: "string", example: "10-A" },
      isActive: { type: "boolean", example: true },
      createdBy: { $ref: "#/components/schemas/UserRef" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  Subject: {
    type: "object",
    properties: {
      _id: { type: "string" },
      name: { type: "string", example: "Matematika" },
      description: { type: "string", example: "Algebra va geometriya" },
      isActive: { type: "boolean", example: true },
      createdBy: { $ref: "#/components/schemas/UserRef" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  Topic: {
    type: "object",
    properties: {
      _id: { type: "string" },
      subject: { type: "string", description: "Subject ObjectId" },
      order: { type: "integer", example: 1 },
      name: { type: "string", example: "Kirish. Sonlar" },
      description: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  // Dars jadvali
  ScheduleSubjectItem: {
    type: "object",
    properties: {
      subject: { $ref: "#/components/schemas/SubjectRef" },
      teacher: { $ref: "#/components/schemas/UserRef" },
      order: { type: "integer", example: 1, description: "Dars tartibi (1-100)" },
      startTime: { type: "string", nullable: true, example: "09:00" },
      endTime: { type: "string", nullable: true, example: "09:45" },
    },
  },
  Schedule: {
    type: "object",
    properties: {
      _id: { type: "string" },
      class: { type: "string", description: "Class ObjectId" },
      day: {
        type: "string",
        enum: ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"],
        example: "dushanba",
      },
      subjects: {
        type: "array",
        items: { $ref: "#/components/schemas/ScheduleSubjectItem" },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  // Davomat
  Attendance: {
    type: "object",
    properties: {
      _id: { type: "string" },
      user: { type: "string" },
      date: { type: "string", format: "date-time" },
      checkIn: { type: "string", format: "date-time", nullable: true },
      checkOut: { type: "string", format: "date-time", nullable: true },
      status: {
        type: "string",
        enum: ["present", "late", "absent", "excused"],
        example: "present",
      },
      isLate: { type: "boolean", example: false },
      lateMinutes: { type: "number", example: 0 },
      isEarlyOut: { type: "boolean", example: false },
      earlyOutMinutes: { type: "number", example: 0 },
    },
  },
  GeoCheckRequest: {
    type: "object",
    required: ["lat", "lng"],
    properties: {
      lat: { type: "number", example: 41.311081 },
      lng: { type: "number", example: 69.240562 },
      accuracy: { type: "number", example: 15 },
    },
  },
  ExcuseRequest: {
    type: "object",
    properties: {
      _id: { type: "string" },
      user: { type: "string" },
      date: { type: "string", format: "date-time" },
      absenceReason: { $ref: "#/components/schemas/AbsenceReason" },
      reason: { type: "string", nullable: true },
      type: { type: "string", enum: ["advance", "after"], example: "advance" },
      status: {
        type: "string",
        enum: ["pending", "approved", "rejected"],
        example: "pending",
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  ExcuseCreateRequest: {
    type: "object",
    required: ["date", "type", "absenceReason"],
    properties: {
      date: { type: "string", format: "date", example: "2026-07-16" },
      type: {
        type: "string",
        enum: ["advance", "after"],
        description: "advance - oldindan, after - keyin",
      },
      absenceReason: { type: "string", description: "AbsenceReason ObjectId" },
      reason: { type: "string", maxLength: 500, example: "Shifokorga borishim kerak" },
    },
  },
  AbsenceReason: {
    type: "object",
    properties: {
      _id: { type: "string" },
      title: { type: "string", example: "Kasallik" },
      description: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
      appliesToAll: { type: "boolean" },
      isActive: { type: "boolean" },
    },
  },

  // Bayramlar
  Holiday: {
    type: "object",
    properties: {
      _id: { type: "string" },
      name: { type: "string", example: "Mustaqillik kuni" },
      description: { type: "string" },
      type: { type: "string", enum: ["single", "range", "recurring"], example: "single" },
      date: { type: "string", format: "date-time", nullable: true },
      startDate: { type: "string", format: "date-time", nullable: true },
      endDate: { type: "string", format: "date-time", nullable: true },
      isActive: { type: "boolean", example: true },
      createdBy: { $ref: "#/components/schemas/UserRef" },
    },
  },
  HolidayCheckResponse: {
    type: "object",
    properties: {
      success: { type: "boolean", example: true },
      data: {
        type: "object",
        properties: {
          isHoliday: { type: "boolean", example: false },
          holiday: {
            nullable: true,
            allOf: [{ $ref: "#/components/schemas/Holiday" }],
          },
        },
      },
    },
  },

  // Jarimalar
  PenaltyCategory: {
    type: "object",
    properties: {
      _id: { type: "string" },
      title: { type: "string", example: "Kechikish" },
      description: { type: "string" },
      points: { type: "number", example: 2 },
      targetRole: { type: "string", example: "student" },
      isActive: { type: "boolean" },
    },
  },
  Penalty: {
    type: "object",
    properties: {
      _id: { type: "string" },
      user: { type: "string" },
      givenBy: { type: "string" },
      category: { type: "string", nullable: true },
      type: { type: "string", enum: ["penalty", "reduction"], example: "penalty" },
      title: { type: "string" },
      description: { type: "string" },
      points: { type: "number", example: 2 },
      status: {
        type: "string",
        enum: ["pending", "approved", "rejected"],
        example: "pending",
      },
      isCustom: { type: "boolean" },
      attachments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            url: { type: "string" },
            type: { type: "string", enum: ["image", "video", "document"] },
            originalName: { type: "string" },
            sizeBytes: { type: "number" },
          },
        },
      },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  // Baholar
  Grade: {
    type: "object",
    properties: {
      _id: { type: "string" },
      student: { $ref: "#/components/schemas/UserRef" },
      subject: { $ref: "#/components/schemas/SubjectRef" },
      teacher: { $ref: "#/components/schemas/UserRef" },
      class: { $ref: "#/components/schemas/ClassRef" },
      grade: { type: "integer", minimum: 1, maximum: 5, example: 5 },
      comment: { type: "string", maxLength: 512 },
      date: { type: "string", format: "date-time" },
      lessonOrder: { type: "integer", example: 1 },
      isEdited: { type: "boolean", example: false },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  GradeCreateRequest: {
    type: "object",
    required: ["studentId", "subjectId", "classId", "grade"],
    properties: {
      studentId: { type: "string", description: "User (student) ObjectId" },
      subjectId: { type: "string", description: "Subject ObjectId" },
      classId: { type: "string", description: "Class ObjectId" },
      grade: { type: "integer", minimum: 1, maximum: 5, example: 5 },
      comment: { type: "string", maxLength: 512 },
      lessonOrder: { type: "integer", minimum: 1, example: 1 },
    },
  },

  // Topshiriqlar
  Task: {
    type: "object",
    properties: {
      _id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      assignee: { $ref: "#/components/schemas/UserRef" },
      createdBy: { $ref: "#/components/schemas/UserRef" },
      status: {
        type: "string",
        enum: [
          "pending",
          "extended",
          "pending_rejected",
          "stopped",
          "completed",
          "pending_review",
        ],
        example: "pending",
      },
      dueDate: { type: "string", format: "date-time" },
      penaltyPoints: { type: "number", example: 1 },
      completionNote: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  // Xabarlar
  Message: {
    type: "object",
    properties: {
      _id: { type: "string" },
      messageText: { type: "string" },
      sentBy: { $ref: "#/components/schemas/UserRef" },
      recipientType: {
        type: "string",
        enum: ["all", "class", "student"],
        example: "class",
      },
      classId: { $ref: "#/components/schemas/ClassRef" },
      studentId: { $ref: "#/components/schemas/UserRef" },
      totalRecipients: { type: "integer", example: 25 },
      createdAt: { type: "string", format: "date-time" },
    },
  },

  // O'qituvchi biriktiruvlari
  TeacherAssignment: {
    type: "object",
    properties: {
      _id: { type: "string" },
      season: { type: "object", properties: { _id: { type: "string" }, name: { type: "string" } } },
      class: { $ref: "#/components/schemas/ClassRef" },
      subject: { $ref: "#/components/schemas/SubjectRef" },
      teacher: { $ref: "#/components/schemas/UserRef" },
      isActive: { type: "boolean", example: true },
    },
  },

  // Testlar
  TestSeason: {
    type: "object",
    properties: {
      _id: { type: "string" },
      name: { type: "string", example: "2026 Bahor mavsumi" },
      description: { type: "string" },
      startDate: { type: "string", format: "date-time" },
      endDate: { type: "string", format: "date-time" },
      status: { type: "string", enum: ["draft", "active", "closed"], example: "active" },
      isActive: { type: "boolean" },
    },
  },
  Test: {
    type: "object",
    properties: {
      _id: { type: "string" },
      teacher: { type: "string" },
      title: { type: "string", example: "1-chorak nazorat testi" },
      questionCount: { type: "integer", example: 30 },
      timeLimitMinutes: { type: "integer", example: 30 },
      isActive: { type: "boolean", example: true },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  TestCreateRequest: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", example: "1-chorak nazorat testi" },
      questionCount: { type: "integer", default: 30, example: 30 },
      timeLimitMinutes: { type: "integer", default: 30, example: 30 },
    },
  },
  QuestionOption: {
    type: "object",
    properties: {
      text: { type: "string" },
      image: { type: "object", nullable: true },
      isCorrect: { type: "boolean" },
    },
  },
  Question: {
    type: "object",
    properties: {
      _id: { type: "string" },
      test: { type: "string" },
      type: { type: "string", enum: ["standard", "open"], example: "standard" },
      text: { type: "string" },
      image: { type: "object", nullable: true },
      difficulty: { type: "string", enum: ["easy", "medium", "hard"], example: "medium" },
      points: { type: "number", example: 1 },
      options: {
        type: "array",
        items: { $ref: "#/components/schemas/QuestionOption" },
      },
      order: { type: "integer" },
      isActive: { type: "boolean" },
    },
  },
  TestBinding: {
    type: "object",
    properties: {
      _id: { type: "string" },
      test: { type: "string" },
      teacher: { type: "string" },
      season: { type: "string" },
      subject: { type: "string" },
      classes: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["draft", "published", "closed"] },
      reopenGrants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            student: { type: "string" },
            grantedBy: { type: "string" },
            grantedAt: { type: "string", format: "date-time" },
          },
        },
      },
      isActive: { type: "boolean" },
    },
  },
  TestBindingCreateRequest: {
    type: "object",
    required: ["season", "subject"],
    properties: {
      season: { type: "string", description: "TestSeason ObjectId" },
      subject: { type: "string", description: "Subject ObjectId" },
      classes: {
        type: "array",
        items: { type: "string", description: "Class ObjectId" },
      },
    },
  },

  // Test natijalari
  TestResult: {
    type: "object",
    properties: {
      _id: { type: "string" },
      test: { type: "object" },
      student: { $ref: "#/components/schemas/UserRef" },
      season: { type: "object" },
      subject: { type: "object" },
      class: { type: "object" },
      autoGradedScore: { type: "number", example: 20 },
      manualGradedScore: { type: "number", example: 8 },
      finalScore: { type: "number", example: 30 },
      gradingMin: { type: "number", example: 55 },
      gradingMax: { type: "number", example: 100 },
      passed: { type: "boolean", example: false },
      status: {
        type: "string",
        enum: ["pending", "partially_graded", "graded"],
        example: "pending",
      },
      extraPoints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            _id: { type: "string" },
            amount: { type: "number" },
            reason: { type: "string" },
            addedAt: { type: "string", format: "date-time" },
          },
        },
      },
      perQuestion: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            awardedPoints: { type: "number" },
            maxPoints: { type: "number" },
            status: { type: "string", enum: ["pending", "graded"] },
            feedback: { type: "string" },
          },
        },
      },
    },
  },
  GradeOpenAnswerRequest: {
    type: "object",
    required: ["questionId", "awardedPoints"],
    properties: {
      questionId: { type: "string", description: "Question ObjectId" },
      awardedPoints: { type: "number", description: "0 dan maxPoints gacha", example: 5 },
      feedback: { type: "string", maxLength: 1024 },
    },
  },
  ExtraPointsRequest: {
    type: "object",
    required: ["amount", "reason"],
    properties: {
      amount: { type: "number", example: 3 },
      reason: { type: "string", maxLength: 512, example: "Faol ishtirok uchun" },
    },
  },

  // Test sessiyalari
  TestSession: {
    type: "object",
    properties: {
      _id: { type: "string" },
      test: { type: "object" },
      student: { $ref: "#/components/schemas/UserRef" },
      attemptNumber: { type: "integer", example: 1 },
      status: {
        type: "string",
        enum: ["in_progress", "submitted", "expired"],
        example: "submitted",
      },
      startedAt: { type: "string", format: "date-time" },
      submittedAt: { type: "string", format: "date-time", nullable: true },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
};

// ---------------------------------------------------------------------------
// Qayta ishlatiladigan javoblar
// ---------------------------------------------------------------------------

const responses = {
  Unauthorized: {
    description: "Token yo'q yoki yaroqsiz (401)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  Forbidden: {
    description: "Ruxsat yo'q — rol mos kelmadi (403)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  NotFound: {
    description: "Topilmadi (404)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  BadRequest: {
    description: "So'rov noto'g'ri (400)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
};

// Ko'p ishlatiladigan javob shablonlari (envelope: { success, data })
const okData = (schemaRef, isArray = false) => ({
  description: "Muvaffaqiyatli",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: isArray
            ? { type: "array", items: { $ref: schemaRef } }
            : { $ref: schemaRef },
        },
      },
    },
  },
});

const okMessage = {
  description: "Muvaffaqiyatli",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string", example: "Bajarildi" },
        },
      },
    },
  },
};

const xlsxResponse = {
  description: "Excel (.xlsx) fayl (blob)",
  content: {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
      schema: { type: "string", format: "binary" },
    },
  },
};

// Umumiy path parametr
const idParam = (name = "id", desc = "ObjectId") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description: desc,
});

// ---------------------------------------------------------------------------
// Yo'llar (paths) — FAQAT o'qituvchi (teacher) kira oladigan endpointlar
// ---------------------------------------------------------------------------

const paths = {
  // ===================== AUTENTIFIKATSIYA =====================
  "/auth/login": {
    post: {
      tags: ["Autentifikatsiya"],
      summary: "Tizimga kirish",
      description: "Ruxsat: hamma (public). `username` va `password` orqali JWT token oladi.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } },
        },
      },
      responses: {
        200: {
          description: "Token va foydalanuvchi",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } },
          },
        },
        400: responses.BadRequest,
        403: responses.Forbidden,
      },
    },
  },
  "/auth/me": {
    get: {
      tags: ["Autentifikatsiya"],
      summary: "Joriy foydalanuvchi ma'lumotlari",
      description: "Ruxsat: token bilan kirgan har qanday foydalanuvchi.",
      responses: {
        200: okData("#/components/schemas/User"),
        401: responses.Unauthorized,
      },
    },
  },

  // ===================== FOYDALANUVCHILAR (o'qituvchiga ruxsat berilganlari) =====================
  "/users/all-short": {
    get: {
      tags: ["Foydalanuvchilar"],
      summary: "Barcha foydalanuvchilar (qisqa)",
      description: "Ruxsat: owner, teacher, reception.",
      responses: {
        200: okData("#/components/schemas/UserRef", true),
        401: responses.Unauthorized,
      },
    },
  },
  "/users/students": {
    get: {
      tags: ["Foydalanuvchilar"],
      summary: "O'quvchilar ro'yxati (qisqa)",
      description: "Ruxsat: owner, teacher. Baho/xabar uchun o'quvchilarni tanlashda ishlatiladi.",
      parameters: [
        { name: "search", in: "query", schema: { type: "string" } },
        { name: "limit", in: "query", schema: { type: "integer", default: 500 } },
      ],
      responses: {
        200: okData("#/components/schemas/User", true),
        401: responses.Unauthorized,
      },
    },
  },

  // ===================== SINFLAR (faqat o'qish) =====================
  "/classes": {
    get: {
      tags: ["Sinflar"],
      summary: "Sinflar ro'yxati",
      description: "Ruxsat: token bilan kirgan har qanday foydalanuvchi.",
      responses: {
        200: okData("#/components/schemas/Class", true),
        401: responses.Unauthorized,
      },
    },
  },
  "/classes/{id}": {
    get: {
      tags: ["Sinflar"],
      summary: "Bitta sinf (o'quvchilari bilan)",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      parameters: [idParam("id", "Class ObjectId")],
      responses: { 200: okData("#/components/schemas/Class"), 404: responses.NotFound },
    },
  },

  // ===================== FANLAR (faqat o'qish) =====================
  "/subjects": {
    get: {
      tags: ["Fanlar"],
      summary: "Fanlar ro'yxati",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      responses: {
        200: okData("#/components/schemas/Subject", true),
        401: responses.Unauthorized,
      },
    },
  },

  // ===================== MAVZULAR (faqat o'qish) =====================
  "/topics/subject/{subjectId}": {
    get: {
      tags: ["Mavzular"],
      summary: "Fan bo'yicha mavzular",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      parameters: [idParam("subjectId", "Subject ObjectId")],
      responses: { 200: okData("#/components/schemas/Topic", true), 404: responses.NotFound },
    },
  },

  // ===================== DARS JADVALI =====================
  "/schedules/my-today": {
    get: {
      tags: ["Dars jadvali"],
      summary: "Mening bugungi darslarim",
      description: "Ruxsat: teacher.",
      responses: { 200: okData("#/components/schemas/Schedule", true), 403: responses.Forbidden },
    },
  },
  "/schedules/class/{classId}": {
    get: {
      tags: ["Dars jadvali"],
      summary: "Sinf dars jadvali (haftalik)",
      description: "Ruxsat: owner, teacher.",
      parameters: [idParam("classId", "Class ObjectId")],
      responses: { 200: okData("#/components/schemas/Schedule", true), 401: responses.Unauthorized },
    },
  },
  "/schedules/class/{classId}/day/{day}": {
    get: {
      tags: ["Dars jadvali"],
      summary: "Sinfning bir kunlik jadvali",
      description: "Ruxsat: owner, teacher.",
      parameters: [
        idParam("classId", "Class ObjectId"),
        {
          name: "day",
          in: "path",
          required: true,
          schema: {
            type: "string",
            enum: ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"],
          },
        },
      ],
      responses: { 200: okData("#/components/schemas/Schedule"), 404: responses.NotFound },
    },
  },
  "/schedules/class/{classId}/export": {
    get: {
      tags: ["Dars jadvali"],
      summary: "Sinf jadvalini Excelga eksport",
      description: "Ruxsat: owner, teacher.",
      parameters: [idParam("classId", "Class ObjectId")],
      responses: { 200: xlsxResponse, 403: responses.Forbidden },
    },
  },

  // ===================== DAVOMAT (O'QITUVCHI) =====================
  "/attendance/check-in": {
    post: {
      tags: ["Davomat"],
      summary: "Ishga kelishni belgilash (check-in)",
      description: "Ruxsat: token bilan kirgan xodim. Geolokatsiya majburiy.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/GeoCheckRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/Attendance"), 400: responses.BadRequest },
    },
  },
  "/attendance/check-out": {
    post: {
      tags: ["Davomat"],
      summary: "Ishdan ketishni belgilash (check-out)",
      description: "Ruxsat: token bilan kirgan xodim. Geolokatsiya majburiy.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/GeoCheckRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/Attendance"), 400: responses.BadRequest },
    },
  },
  "/attendance/today": {
    get: {
      tags: ["Davomat"],
      summary: "Bugungi davomatim",
      description: "Ruxsat: token bilan kirgan xodim.",
      responses: { 200: okData("#/components/schemas/Attendance"), 401: responses.Unauthorized },
    },
  },
  "/attendance/my-schedule": {
    get: {
      tags: ["Davomat"],
      summary: "Ish jadvalim (vaqt va kunlar)",
      description: "Ruxsat: token bilan kirgan xodim.",
      responses: {
        200: {
          description: "Ish jadvali",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: {
                    type: "object",
                    properties: {
                      workStartTime: { type: "string", nullable: true },
                      workEndTime: { type: "string", nullable: true },
                      workDays: { type: "array", items: { type: "integer" } },
                      isWorkDayToday: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
        401: responses.Unauthorized,
      },
    },
  },
  "/attendance/my": {
    get: {
      tags: ["Davomat"],
      summary: "Davomat tarixim (oy bo'yicha)",
      description: "Ruxsat: token bilan kirgan xodim.",
      parameters: [
        { name: "month", in: "query", schema: { type: "integer" }, description: "1-12" },
        { name: "year", in: "query", schema: { type: "integer" }, description: "Masalan 2026" },
      ],
      responses: {
        200: {
          description: "Yozuvlar + xulosa",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  records: { type: "array", items: { $ref: "#/components/schemas/Attendance" } },
                  summary: {
                    type: "object",
                    properties: {
                      present: { type: "integer" },
                      late: { type: "integer" },
                      absent: { type: "integer" },
                      excused: { type: "integer" },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        401: responses.Unauthorized,
      },
    },
  },
  "/attendance/excuse": {
    post: {
      tags: ["Davomat"],
      summary: "Kelmaslik uchun ariza yuborish",
      description: "Ruxsat: token bilan kirgan xodim.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ExcuseCreateRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/ExcuseRequest"), 400: responses.BadRequest },
    },
  },
  "/attendance/excuse/my": {
    get: {
      tags: ["Davomat"],
      summary: "Mening arizalarim",
      description: "Ruxsat: token bilan kirgan xodim.",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
        {
          name: "status",
          in: "query",
          schema: { type: "string", enum: ["pending", "approved", "rejected"] },
        },
      ],
      responses: {
        200: {
          description: "Arizalar + paginatsiya",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "array", items: { $ref: "#/components/schemas/ExcuseRequest" } },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        401: responses.Unauthorized,
      },
    },
  },
  "/attendance/excuse/{id}": {
    delete: {
      tags: ["Davomat"],
      summary: "Arizani bekor qilish",
      description: "Ruxsat: ariza egasi.",
      parameters: [idParam("id", "ExcuseRequest ObjectId")],
      responses: { 200: okMessage, 404: responses.NotFound },
    },
  },
  "/absence-reasons/applicable": {
    get: {
      tags: ["Davomat"],
      summary: "O'z roliga tegishli kelmaslik sabablari",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      responses: {
        200: okData("#/components/schemas/AbsenceReason", true),
        401: responses.Unauthorized,
      },
    },
  },

  // ===================== BAYRAMLAR (faqat o'qish) =====================
  "/holidays": {
    get: {
      tags: ["Bayramlar"],
      summary: "Bayram / dam olish kunlari ro'yxati",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      responses: {
        200: okData("#/components/schemas/Holiday", true),
        401: responses.Unauthorized,
      },
    },
  },
  "/holidays/check/today": {
    get: {
      tags: ["Bayramlar"],
      summary: "Bugun bayrammi?",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      responses: {
        200: {
          description: "Natija",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/HolidayCheckResponse" } },
          },
        },
        401: responses.Unauthorized,
      },
    },
  },
  "/holidays/check/{date}": {
    get: {
      tags: ["Bayramlar"],
      summary: "Berilgan sana bayrammi?",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      parameters: [
        {
          name: "date",
          in: "path",
          required: true,
          schema: { type: "string", format: "date" },
          description: "YYYY-MM-DD",
        },
      ],
      responses: {
        200: {
          description: "Natija",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/HolidayCheckResponse" } },
          },
        },
      },
    },
  },

  // ===================== JARIMALAR =====================
  "/penalties/categories": {
    get: {
      tags: ["Jarimalar"],
      summary: "Jarima kategoriyalari",
      description: "Ruxsat: owner, teacher, reception.",
      parameters: [
        {
          name: "targetRole",
          in: "query",
          schema: { type: "string", enum: ["teacher", "student", "reception"] },
        },
      ],
      responses: {
        200: okData("#/components/schemas/PenaltyCategory", true),
        403: responses.Forbidden,
      },
    },
  },
  "/penalties": {
    post: {
      tags: ["Jarimalar"],
      summary: "Jarima berish",
      description: "Ruxsat: owner, teacher, reception. `multipart/form-data` (dalil fayllar bilan).",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["userId"],
              properties: {
                userId: { type: "string", description: "Kimga (User ObjectId)" },
                categoryId: { type: "string", description: "Kategoriya (isCustom=false bo'lsa)" },
                isCustom: { type: "boolean", description: "Maxsus jarima" },
                title: { type: "string", description: "isCustom=true bo'lsa majburiy" },
                description: { type: "string" },
                points: { type: "number", description: "isCustom=true bo'lsa majburiy" },
                files: {
                  type: "array",
                  items: { type: "string", format: "binary" },
                  description: "Dalil fayllar (maks 5)",
                },
              },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/Penalty"), 400: responses.BadRequest },
    },
  },
  "/penalties/settings": {
    get: {
      tags: ["Jarimalar"],
      summary: "Jarima sozlamalari (jarima summalari)",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      responses: { 200: okMessage, 401: responses.Unauthorized },
    },
  },
  "/penalties/my": {
    get: {
      tags: ["Jarimalar"],
      summary: "Menga berilgan jarimalar",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
      ],
      responses: {
        200: {
          description: "Jarimalar + paginatsiya",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "array", items: { $ref: "#/components/schemas/Penalty" } },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        401: responses.Unauthorized,
      },
    },
  },
  "/penalties/given": {
    get: {
      tags: ["Jarimalar"],
      summary: "Men bergan jarimalar",
      description: "Ruxsat: teacher, reception.",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", default: 10 } },
      ],
      responses: {
        200: {
          description: "Jarimalar + paginatsiya",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "array", items: { $ref: "#/components/schemas/Penalty" } },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        403: responses.Forbidden,
      },
    },
  },

  // ===================== BAHOLAR =====================
  "/grades": {
    get: {
      tags: ["Baholar"],
      summary: "Baholar ro'yxati (filtr bilan)",
      description: "Ruxsat: owner, teacher.",
      parameters: [
        { name: "studentId", in: "query", schema: { type: "string" } },
        { name: "subjectId", in: "query", schema: { type: "string" } },
        { name: "classId", in: "query", schema: { type: "string" } },
        { name: "startDate", in: "query", schema: { type: "string", format: "date" } },
        { name: "endDate", in: "query", schema: { type: "string", format: "date" } },
      ],
      responses: { 200: okData("#/components/schemas/Grade", true), 401: responses.Unauthorized },
    },
    post: {
      tags: ["Baholar"],
      summary: "Baho qo'yish",
      description: "Ruxsat: teacher.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/GradeCreateRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/Grade"), 400: responses.BadRequest },
    },
  },
  "/grades/class/{classId}/date/{date}": {
    get: {
      tags: ["Baholar"],
      summary: "Sinfning ma'lum kundagi baholari",
      description: "Ruxsat: owner, teacher.",
      parameters: [
        idParam("classId", "Class ObjectId"),
        {
          name: "date",
          in: "path",
          required: true,
          schema: { type: "string", format: "date" },
          description: "YYYY-MM-DD",
        },
      ],
      responses: { 200: okData("#/components/schemas/Grade", true), 401: responses.Unauthorized },
    },
  },
  "/grades/export": {
    get: {
      tags: ["Baholar"],
      summary: "Baholarni Excelga eksport",
      description: "Ruxsat: owner, teacher.",
      parameters: [
        { name: "classId", in: "query", required: true, schema: { type: "string" } },
        { name: "date", in: "query", required: true, schema: { type: "string", format: "date" } },
        { name: "subjectId", in: "query", schema: { type: "string" } },
      ],
      responses: { 200: xlsxResponse, 400: responses.BadRequest },
    },
  },
  "/grades/teacher/subjects/{classId}": {
    get: {
      tags: ["Baholar"],
      summary: "O'qituvchining shu sinfdagi bugungi fanlari",
      description: "Ruxsat: teacher. Baho qo'yish uchun fan/mavzu ro'yxati.",
      parameters: [idParam("classId", "Class ObjectId")],
      responses: { 200: okData("#/components/schemas/Subject", true), 403: responses.Forbidden },
    },
  },
  "/grades/students-with-grades": {
    get: {
      tags: ["Baholar"],
      summary: "O'quvchilar + baholari (baho qo'yish ekrani)",
      description: "Ruxsat: teacher, owner.",
      parameters: [
        { name: "classId", in: "query", required: true, schema: { type: "string" } },
        { name: "subjectId", in: "query", required: true, schema: { type: "string" } },
        { name: "date", in: "query", required: true, schema: { type: "string", format: "date" } },
        { name: "lessonOrder", in: "query", schema: { type: "integer" } },
      ],
      responses: {
        200: {
          description: "O'quvchilar va ularning bahosi",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        _id: { type: "string" },
                        firstName: { type: "string" },
                        lastName: { type: "string" },
                        grade: {
                          nullable: true,
                          allOf: [{ $ref: "#/components/schemas/Grade" }],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        403: responses.Forbidden,
      },
    },
  },
  "/grades/{id}": {
    put: {
      tags: ["Baholar"],
      summary: "Bahoni tahrirlash",
      description: "Ruxsat: teacher.",
      parameters: [idParam("id", "Grade ObjectId")],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                grade: { type: "integer", minimum: 1, maximum: 5 },
                comment: { type: "string" },
              },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/Grade"), 404: responses.NotFound },
    },
    delete: {
      tags: ["Baholar"],
      summary: "Bahoni o'chirish",
      description: "Ruxsat: teacher, owner.",
      parameters: [idParam("id", "Grade ObjectId")],
      responses: { 200: okMessage, 404: responses.NotFound },
    },
  },

  // ===================== TOPSHIRIQLAR =====================
  "/tasks/my": {
    get: {
      tags: ["Topshiriqlar"],
      summary: "Mening topshiriqlarim",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", default: 24 } },
        {
          name: "status",
          in: "query",
          schema: {
            type: "string",
            enum: [
              "pending",
              "extended",
              "pending_rejected",
              "stopped",
              "completed",
              "pending_review",
              "all",
            ],
          },
        },
      ],
      responses: {
        200: {
          description: "Topshiriqlar + paginatsiya",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "array", items: { $ref: "#/components/schemas/Task" } },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        401: responses.Unauthorized,
      },
    },
  },
  "/tasks/{id}": {
    get: {
      tags: ["Topshiriqlar"],
      summary: "Topshiriq tafsilotlari",
      description: "Ruxsat: token bilan kirgan foydalanuvchi.",
      parameters: [idParam("id", "Task ObjectId")],
      responses: { 200: okData("#/components/schemas/Task"), 404: responses.NotFound },
    },
  },
  "/tasks/{id}/submit": {
    put: {
      tags: ["Topshiriqlar"],
      summary: "Topshiriqni bajarildi deb topshirish",
      description: "Ruxsat: topshiriq egasi. `multipart/form-data`.",
      parameters: [idParam("id", "Task ObjectId")],
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                note: { type: "string", description: "Izoh" },
                files: {
                  type: "array",
                  items: { type: "string", format: "binary" },
                  description: "Fayllar (maks 5)",
                },
              },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/Task"), 400: responses.BadRequest },
    },
  },

  // ===================== XABARLAR =====================
  "/messages": {
    get: {
      tags: ["Xabarlar"],
      summary: "Yuborilgan xabarlar ro'yxati",
      description: "Ruxsat: owner, teacher.",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        { name: "classId", in: "query", schema: { type: "string" } },
        {
          name: "recipientType",
          in: "query",
          schema: { type: "string", enum: ["all", "class", "student"] },
        },
        { name: "startDate", in: "query", schema: { type: "string", format: "date" } },
        { name: "endDate", in: "query", schema: { type: "string", format: "date" } },
      ],
      responses: {
        200: {
          description: "Xabarlar + paginatsiya",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "array", items: { $ref: "#/components/schemas/Message" } },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        403: responses.Forbidden,
      },
    },
    post: {
      tags: ["Xabarlar"],
      summary: "Xabar yuborish (Telegram)",
      description: "Ruxsat: owner, teacher. `multipart/form-data`.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["messageText", "recipientType"],
              properties: {
                messageText: { type: "string", maxLength: 2048 },
                recipientType: { type: "string", enum: ["all", "class", "student"] },
                classId: { type: "string", description: "recipientType=class bo'lsa" },
                studentId: { type: "string", description: "recipientType=student bo'lsa" },
                file: { type: "string", format: "binary", description: "Rasm/hujjat (ixtiyoriy)" },
              },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/Message"), 400: responses.BadRequest },
    },
  },
  "/messages/{id}": {
    get: {
      tags: ["Xabarlar"],
      summary: "Bitta xabar (yetkazish holati bilan)",
      description: "Ruxsat: owner, teacher.",
      parameters: [idParam("id", "Message ObjectId")],
      responses: { 200: okData("#/components/schemas/Message"), 404: responses.NotFound },
    },
  },
  "/messages/{id}/cancel": {
    patch: {
      tags: ["Xabarlar"],
      summary: "Xabar yuborishni bekor qilish",
      description: "Ruxsat: owner, teacher. Hali yuborilmagan (pending) xabarlarni bekor qiladi.",
      parameters: [idParam("id", "Message ObjectId")],
      responses: { 200: okMessage, 404: responses.NotFound },
    },
  },

  // ===================== O'QITUVCHI BIRIKTIRUVLARI =====================
  "/teacher-assignments/my": {
    get: {
      tags: ["O'qituvchi biriktiruvlari"],
      summary: "Mening biriktiruvlarim (sinf/fan)",
      description: "Ruxsat: teacher. UI da ko'rinadigan sinf/fanlarni cheklaydi.",
      parameters: [
        { name: "season", in: "query", schema: { type: "string" }, description: "TestSeason ObjectId" },
      ],
      responses: {
        200: okData("#/components/schemas/TeacherAssignment", true),
        403: responses.Forbidden,
      },
    },
  },

  // ===================== TEST MAVSUMLARI (o'qish + statistika) =====================
  "/test-seasons/active": {
    get: {
      tags: ["Test mavsumlari"],
      summary: "Faol mavsumlar",
      description: "Ruxsat: owner, teacher, student.",
      responses: {
        200: okData("#/components/schemas/TestSeason", true),
        401: responses.Unauthorized,
      },
    },
  },
  "/test-seasons/{id}": {
    get: {
      tags: ["Test mavsumlari"],
      summary: "Bitta mavsum",
      description: "Ruxsat: owner, teacher, student.",
      parameters: [idParam("id", "TestSeason ObjectId")],
      responses: { 200: okData("#/components/schemas/TestSeason"), 404: responses.NotFound },
    },
  },
  "/test-seasons/{id}/stats": {
    get: {
      tags: ["Test mavsumlari"],
      summary: "Mavsum statistikasi",
      description: "Ruxsat: owner, teacher, student.",
      parameters: [
        idParam("id", "TestSeason ObjectId"),
        { name: "classId", in: "query", schema: { type: "string" } },
        { name: "subjectId", in: "query", schema: { type: "string" } },
      ],
      responses: { 200: okData("#/components/schemas/TestSeason"), 404: responses.NotFound },
    },
  },
  "/test-seasons/{id}/class/{classId}/stats": {
    get: {
      tags: ["Test mavsumlari"],
      summary: "Mavsum bo'yicha sinf statistikasi",
      description: "Ruxsat: owner, teacher, student.",
      parameters: [
        idParam("id", "TestSeason ObjectId"),
        idParam("classId", "Class ObjectId"),
      ],
      responses: { 200: okData("#/components/schemas/TestSeason"), 404: responses.NotFound },
    },
  },

  // ===================== TESTLAR =====================
  "/tests": {
    get: {
      tags: ["Testlar"],
      summary: "Testlar ro'yxati",
      description: "Ruxsat: teacher (o'z testlari).",
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer" } },
        { name: "search", in: "query", schema: { type: "string" } },
      ],
      responses: {
        200: {
          description: "Testlar + paginatsiya",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "array", items: { $ref: "#/components/schemas/Test" } },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        403: responses.Forbidden,
      },
    },
    post: {
      tags: ["Testlar"],
      summary: "Yangi test yaratish",
      description: "Ruxsat: teacher.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/TestCreateRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/Test"), 400: responses.BadRequest },
    },
  },
  "/tests/{id}": {
    get: {
      tags: ["Testlar"],
      summary: "Bitta test",
      description: "Ruxsat: owner, teacher.",
      parameters: [idParam("id", "Test ObjectId")],
      responses: { 200: okData("#/components/schemas/Test"), 404: responses.NotFound },
    },
    put: {
      tags: ["Testlar"],
      summary: "Testni tahrirlash",
      description: "Ruxsat: teacher.",
      parameters: [idParam("id", "Test ObjectId")],
      requestBody: {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/TestCreateRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/Test"), 404: responses.NotFound },
    },
    delete: {
      tags: ["Testlar"],
      summary: "Testni o'chirish",
      description: "Ruxsat: teacher.",
      parameters: [idParam("id", "Test ObjectId")],
      responses: { 200: okMessage, 404: responses.NotFound },
    },
  },

  // ===================== TEST SAVOLLARI =====================
  "/tests/{testId}/questions": {
    get: {
      tags: ["Test savollari"],
      summary: "Test savollari",
      description: "Ruxsat: teacher.",
      parameters: [idParam("testId", "Test ObjectId")],
      responses: { 200: okData("#/components/schemas/Question", true), 403: responses.Forbidden },
    },
    post: {
      tags: ["Test savollari"],
      summary: "Savol qo'shish",
      description: "Ruxsat: teacher. `multipart/form-data` (rasmlar bilan).",
      parameters: [idParam("testId", "Test ObjectId")],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["type"],
              properties: {
                type: { type: "string", enum: ["standard", "open"] },
                text: { type: "string" },
                difficulty: { type: "string", enum: ["easy", "medium", "hard"], default: "medium" },
                options: { type: "string", description: "JSON massiv (standard uchun)" },
                imageMap: { type: "string", description: "JSON obyekt (rasm bog'lash)" },
                images: {
                  type: "array",
                  items: { type: "string", format: "binary" },
                  description: "Rasm fayllar",
                },
              },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/Question"), 400: responses.BadRequest },
    },
    delete: {
      tags: ["Test savollari"],
      summary: "Testning barcha savollarini o'chirish",
      description: "Ruxsat: teacher.",
      parameters: [idParam("testId", "Test ObjectId")],
      responses: { 200: okMessage, 404: responses.NotFound },
    },
  },
  "/tests/{testId}/questions/reorder": {
    patch: {
      tags: ["Test savollari"],
      summary: "Savollar tartibini o'zgartirish",
      description: "Ruxsat: teacher.",
      parameters: [idParam("testId", "Test ObjectId")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["orderedIds"],
              properties: {
                orderedIds: {
                  type: "array",
                  items: { type: "string" },
                  description: "Savol ID'lari yangi tartibda",
                },
              },
            },
          },
        },
      },
      responses: { 200: okMessage, 400: responses.BadRequest },
    },
  },
  "/tests/{testId}/questions/ai-generate": {
    post: {
      tags: ["Test savollari"],
      summary: "AI yordamida savol generatsiyasi",
      description: "Ruxsat: teacher. Prompt yoki rasmlar orqali. `multipart/form-data`.",
      parameters: [idParam("testId", "Test ObjectId")],
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                source: { type: "string", enum: ["prompt", "images"], default: "prompt" },
                prompt: { type: "string" },
                count: { type: "integer", default: 5 },
                difficulty: { type: "string", enum: ["easy", "medium", "hard"], default: "medium" },
                type: { type: "string", enum: ["standard", "open"], default: "standard" },
                files: {
                  type: "array",
                  items: { type: "string", format: "binary" },
                  description: "Rasm fayllar (source=images, maks 10)",
                },
              },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/Question", true), 400: responses.BadRequest },
    },
  },
  "/questions/{id}": {
    put: {
      tags: ["Test savollari"],
      summary: "Savolni tahrirlash",
      description: "Ruxsat: teacher. `multipart/form-data`.",
      parameters: [idParam("id", "Question ObjectId")],
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["standard", "open"] },
                text: { type: "string" },
                difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
                options: { type: "string", description: "JSON massiv" },
                imageMap: { type: "string", description: "JSON obyekt" },
                removeQuestionImage: { type: "string" },
                images: { type: "array", items: { type: "string", format: "binary" } },
              },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/Question"), 404: responses.NotFound },
    },
    delete: {
      tags: ["Test savollari"],
      summary: "Savolni o'chirish",
      description: "Ruxsat: teacher.",
      parameters: [idParam("id", "Question ObjectId")],
      responses: { 200: okMessage, 404: responses.NotFound },
    },
  },

  // ===================== TEST BIRIKTIRUVLARI =====================
  "/tests/{testId}/bindings": {
    get: {
      tags: ["Test biriktiruvlari"],
      summary: "Test biriktiruvlari",
      description: "Ruxsat: teacher.",
      parameters: [idParam("testId", "Test ObjectId")],
      responses: {
        200: okData("#/components/schemas/TestBinding", true),
        403: responses.Forbidden,
      },
    },
    post: {
      tags: ["Test biriktiruvlari"],
      summary: "Test biriktiruvi yaratish",
      description: "Ruxsat: teacher. Testni mavsum + fan + sinflarga biriktiradi.",
      parameters: [idParam("testId", "Test ObjectId")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TestBindingCreateRequest" },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/TestBinding"), 400: responses.BadRequest },
    },
  },
  "/bindings/{id}": {
    put: {
      tags: ["Test biriktiruvlari"],
      summary: "Biriktiruvni tahrirlash",
      description: "Ruxsat: teacher.",
      parameters: [idParam("id", "TestBinding ObjectId")],
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TestBindingCreateRequest" },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/TestBinding"), 404: responses.NotFound },
    },
    delete: {
      tags: ["Test biriktiruvlari"],
      summary: "Biriktiruvni o'chirish",
      description: "Ruxsat: teacher.",
      parameters: [idParam("id", "TestBinding ObjectId")],
      responses: { 200: okMessage, 404: responses.NotFound },
    },
  },
  "/bindings/{id}/reopen": {
    post: {
      tags: ["Test biriktiruvlari"],
      summary: "O'quvchiga testni qayta ochish",
      description: "Ruxsat: teacher. Muayyan o'quvchiga qayta topshirishga ruxsat beradi.",
      parameters: [idParam("id", "TestBinding ObjectId")],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["studentId"],
              properties: { studentId: { type: "string", description: "User (student) ObjectId" } },
            },
          },
        },
      },
      responses: { 200: okData("#/components/schemas/TestBinding"), 404: responses.NotFound },
    },
  },

  // ===================== TEST NATIJALARI =====================
  "/test-results/by-test/{testId}": {
    get: {
      tags: ["Test natijalari"],
      summary: "Test bo'yicha natijalar",
      description: "Ruxsat: teacher (test muallifi).",
      parameters: [
        idParam("testId", "Test ObjectId"),
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "limit", in: "query", schema: { type: "integer" } },
        {
          name: "status",
          in: "query",
          schema: {
            type: "string",
            enum: ["pending", "partially_graded", "graded", "all"],
          },
        },
      ],
      responses: {
        200: {
          description: "Natijalar + paginatsiya",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  data: { type: "array", items: { $ref: "#/components/schemas/TestResult" } },
                  pagination: { $ref: "#/components/schemas/Pagination" },
                },
              },
            },
          },
        },
        403: responses.Forbidden,
      },
    },
  },
  "/test-results/{id}": {
    get: {
      tags: ["Test natijalari"],
      summary: "Bitta natija (batafsil)",
      description: "Ruxsat: teacher (muallif) yoki o'quvchi (o'ziniki).",
      parameters: [idParam("id", "TestResult ObjectId")],
      responses: { 200: okData("#/components/schemas/TestResult"), 404: responses.NotFound },
    },
  },
  "/test-results/{id}/grade": {
    patch: {
      tags: ["Test natijalari"],
      summary: "Ochiq javobni baholash",
      description: "Ruxsat: teacher. Ochiq (open) savol javobiga ball qo'yadi.",
      parameters: [idParam("id", "TestResult ObjectId")],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/GradeOpenAnswerRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/TestResult"), 400: responses.BadRequest },
    },
  },
  "/test-results/{id}/extra-points": {
    patch: {
      tags: ["Test natijalari"],
      summary: "Qo'shimcha ball qo'shish",
      description: "Ruxsat: teacher.",
      parameters: [idParam("id", "TestResult ObjectId")],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ExtraPointsRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/TestResult"), 400: responses.BadRequest },
    },
  },
  "/test-results/{id}/extra-points/{entryId}": {
    patch: {
      tags: ["Test natijalari"],
      summary: "Qo'shimcha ballni tahrirlash",
      description: "Ruxsat: teacher.",
      parameters: [
        idParam("id", "TestResult ObjectId"),
        idParam("entryId", "extraPoints yozuvi _id"),
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ExtraPointsRequest" } },
        },
      },
      responses: { 200: okData("#/components/schemas/TestResult"), 404: responses.NotFound },
    },
    delete: {
      tags: ["Test natijalari"],
      summary: "Qo'shimcha ballni o'chirish",
      description: "Ruxsat: teacher.",
      parameters: [
        idParam("id", "TestResult ObjectId"),
        idParam("entryId", "extraPoints yozuvi _id"),
      ],
      responses: { 200: okData("#/components/schemas/TestResult"), 404: responses.NotFound },
    },
  },

  // ===================== TEST SESSIYALARI =====================
  "/test-sessions/by-test/{testId}": {
    get: {
      tags: ["Test sessiyalari"],
      summary: "Test bo'yicha sessiyalar",
      description: "Ruxsat: teacher (test muallifi).",
      parameters: [idParam("testId", "Test ObjectId")],
      responses: {
        200: okData("#/components/schemas/TestSession", true),
        403: responses.Forbidden,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Yakuniy OpenAPI spetsifikatsiyasi
// ---------------------------------------------------------------------------

const teacherApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Study-Track — O'qituvchi (Teacher) Paneli API",
    version: "1.0.0",
    description: [
      "Ushbu hujjatda **faqat o'qituvchi (teacher) roli kira oladigan** endpointlar bor.",
      "Owner-only va student-only endpointlar bu yerga kiritilmagan.",
      "",
      "**Autentifikatsiya:** Avval `POST /auth/login` orqali token oling, so'ng",
      "yuqoridagi **Authorize** tugmasi orqali `Bearer <token>` ni kiriting.",
      "",
      "**Javob formati:** Barcha javoblar `{ success, data }` yoki `{ success, message }` ko'rinishida.",
      "Ba'zi ro'yxatlar `pagination` bilan qaytadi.",
      "",
      "**Rollar:** Har bir endpoint tavsifida kerakli rol (\"Ruxsat\") ko'rsatilgan.",
      "\"token bilan kirgan foydalanuvchi\" deganda teacher ham kiradi.",
    ].join("\n"),
  },
  servers: [
    { url: "http://localhost:7070/api", description: "Lokal server" },
    { url: "/api", description: "Joriy host" },
  ],
  tags: [
    { name: "Autentifikatsiya", description: "Kirish va joriy foydalanuvchi" },
    { name: "Foydalanuvchilar", description: "Foydalanuvchilar (o'qituvchiga ochiq qismlari)" },
    { name: "Sinflar", description: "Sinflar (faqat o'qish)" },
    { name: "Fanlar", description: "Fanlar (faqat o'qish)" },
    { name: "Mavzular", description: "Fan mavzulari (faqat o'qish)" },
    { name: "Dars jadvali", description: "Dars jadvali" },
    { name: "Davomat", description: "O'qituvchi davomati (check-in/out, arizalar)" },
    { name: "Bayramlar", description: "Bayram / dam olish kunlari (faqat o'qish)" },
    { name: "Jarimalar", description: "Jarimalar va kategoriyalar" },
    { name: "Baholar", description: "O'quvchilar baholari" },
    { name: "Topshiriqlar", description: "O'qituvchiga berilgan topshiriqlar" },
    { name: "Xabarlar", description: "Telegram xabarlari" },
    { name: "O'qituvchi biriktiruvlari", description: "Sinf/fan biriktiruvlari" },
    { name: "Test mavsumlari", description: "Test mavsumlari va statistikasi" },
    { name: "Testlar", description: "Testlar (savol konteyneri)" },
    { name: "Test savollari", description: "Savollar va AI generatsiya" },
    { name: "Test biriktiruvlari", description: "Testni sinf/mavsumga biriktirish" },
    { name: "Test natijalari", description: "Natijalar va ochiq javoblarni baholash" },
    { name: "Test sessiyalari", description: "O'quvchi test sessiyalari (ko'rish)" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT token. Format: Bearer <token>",
      },
    },
    schemas,
    responses,
  },
  security: [{ bearerAuth: [] }],
  paths,
};

module.exports = teacherApiSpec;
