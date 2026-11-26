/**
 * Study-Track — ISTORIYALAR VA CHAT uchun Swagger/OpenAPI spetsifikatsiyasi.
 *
 * ⚠️ ALOHIDA HUJJAT, `teacherSwagger.js` GA QO'SHILMAGAN va bu ataylab:
 * u yerda "faqat o'qituvchi ko'radigan endpointlar" degan aniq qamrov bor,
 * bu modulda esa xodim, o'quvchi va moderator yo'llari aralash. Bitta
 * faylga yig'ilsa, o'sha qamrov va'dasi buzilardi.
 *
 * Swagger UI: GET /api-docs/social
 * To'liq matnli shartnoma (mobil jamoa shu bilan ishlaydi):
 * `docs/social-api.md` — bu spetsifikatsiya uni ALMASHTIRMAYDI, faqat
 * "so'rovni shu yerdan sinab ko'rish" uchun.
 */

const schemas = {
  Error: {
    type: "object",
    properties: {
      success: { type: "boolean", example: false },
      message: { type: "string", example: "Siz bu suhbatning a'zosi emassiz" },
      details: {
        type: "object",
        description: "Mobil ilova shu `code` bo'yicha oyna ko'rsatadi",
        properties: { code: { type: "string", example: "NOT_MEMBER" } },
      },
    },
  },
  Avatar: {
    type: "object",
    properties: {
      url: { type: "string", nullable: true, example: "https://cdn/.../sm.webp" },
      preset: { type: "string", nullable: true, example: "a07" },
      initials: { type: "string", example: "AV" },
      color: { type: "integer", example: 6, description: "0..7 — ilovadagi palitra indeksi" },
    },
  },
  UserCard: {
    type: "object",
    description: "Odam kartochkasi — javobning HAR joyida AYNI shakl",
    properties: {
      id: { type: "string" },
      firstName: { type: "string" },
      lastName: { type: "string" },
      fullName: { type: "string" },
      role: { type: "string", example: "teacher" },
      branchId: { type: "string" },
      branchName: { type: "string", nullable: true },
      isArchived: { type: "boolean" },
      avatar: { $ref: "#/components/schemas/Avatar" },
    },
  },
  Media: {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["image", "video", "file", "voice"] },
      mime: { type: "string", example: "image/webp" },
      size: { type: "integer" },
      width: { type: "integer", nullable: true },
      height: { type: "integer", nullable: true },
      durationMs: { type: "integer", nullable: true },
      blurhash: { type: "string", nullable: true },
      url: {
        type: "string",
        description: "IMZOLANGAN va muddatli. Kesh kaliti — `id`, URL EMAS",
      },
      thumbUrl: { type: "string", nullable: true },
      expiresIn: { type: "integer", nullable: true, example: 3600 },
    },
  },
  Story: {
    type: "object",
    properties: {
      id: { type: "string" },
      media: { $ref: "#/components/schemas/Media" },
      caption: { type: "string", nullable: true, maxLength: 300 },
      createdAt: { type: "string", format: "date-time" },
      expiresAt: { type: "string", format: "date-time" },
      inFeed: { type: "boolean", description: "false — 24 soatdan o'tgan, profilda turadi" },
      seen: { type: "boolean" },
      liked: { type: "boolean" },
      commentsCount: { type: "integer" },
      viewsCount: { type: "integer", description: "FAQAT muallifga keladi" },
      likesCount: { type: "integer", description: "FAQAT muallifga keladi" },
    },
  },
  Conversation: {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string", enum: ["direct", "group", "class"] },
      title: { type: "string", nullable: true },
      partner: { $ref: "#/components/schemas/UserCard" },
      classId: { type: "string", nullable: true },
      branchId: { type: "string", nullable: true },
      memberCount: { type: "integer" },
      lastSeq: { type: "integer" },
      lastMessageAt: { type: "string", format: "date-time", nullable: true },
      lastPreview: { type: "string", nullable: true },
      unreadCount: { type: "integer", description: "lastSeq − lastReadSeq" },
      onlyStaffPost: { type: "boolean" },
      slowModeSec: { type: "integer" },
      closedAt: { type: "string", format: "date-time", nullable: true },
      myRole: { type: "string", enum: ["owner", "admin", "member"], nullable: true },
      pinned: { type: "boolean" },
      archived: { type: "boolean" },
      mutedUntil: { type: "string", format: "date-time", nullable: true },
      postBannedUntil: { type: "string", format: "date-time", nullable: true },
    },
  },
  Message: {
    type: "object",
    properties: {
      id: { type: "string" },
      conversationId: { type: "string" },
      seq: { type: "integer", description: "Suhbatdagi O'RIN — tahrir/o'chirish o'zgartirmaydi" },
      clientId: { type: "string" },
      type: {
        type: "string",
        enum: ["text", "image", "video", "voice", "file", "story_reply", "system"],
      },
      text: { type: "string", nullable: true },
      media: { $ref: "#/components/schemas/Media" },
      replyToId: { type: "string", nullable: true },
      storyId: { type: "string", nullable: true },
      forwardedFromId: { type: "string", nullable: true },
      flagged: { type: "boolean", description: "So'kinish filtri belgisi — BLOKLAMAYDI" },
      sender: { $ref: "#/components/schemas/UserCard" },
      createdAt: { type: "string", format: "date-time" },
      editedAt: { type: "string", format: "date-time", nullable: true },
      deletedAt: { type: "string", format: "date-time", nullable: true },
    },
  },
  CursorPagination: {
    type: "object",
    properties: {
      nextCursor: { type: "string", nullable: true },
      hasMore: { type: "boolean" },
    },
  },
};

const responses = {
  Unauthorized: {
    description: "Token yo'q yoki muddati o'tgan",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  Forbidden: {
    description: "Ruxsat yo'q (xodim emas, a'zo emas, ota-ona kanali…)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  NotFound: {
    description: "Topilmadi",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  TooMany: {
    description: "Chegara (kunlik limit, sekin rejim, tezlik)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
};

const ok = (schema, description = "OK") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { success: { type: "boolean", example: true }, data: schema },
      },
    },
  },
});

const okList = (itemSchema, description = "OK") => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          items: { type: "array", items: itemSchema },
          pagination: { $ref: "#/components/schemas/CursorPagination" },
        },
      },
    },
  },
});

const idParam = (name = "id") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});

const cursorParams = [
  { name: "cursor", in: "query", schema: { type: "string" } },
  { name: "limit", in: "query", schema: { type: "integer", default: 30 } },
];

const paths = {
  /* ─────────────────────────── MEDIA ─────────────────────────── */
  "/social/uploads": {
    post: {
      tags: ["Media"],
      summary: "Yuklash uchun ruxsat (imzolangan PUT havolasi)",
      description:
        "Katta fayl server orqali o'tmaydi. `mode: presigned` → `putUrl` ga PUT; " +
        "`mode: multipart` (lokal dev) → `multipartUrl` ga multipart POST.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["kind", "mime", "size", "purpose"],
              properties: {
                kind: { type: "string", enum: ["image", "video", "file", "voice"] },
                mime: { type: "string", example: "image/jpeg" },
                size: { type: "integer", example: 842113 },
                width: { type: "integer" },
                height: { type: "integer" },
                durationMs: { type: "integer" },
                purpose: { type: "string", enum: ["story", "chat", "avatar"] },
              },
            },
          },
        },
      },
      responses: {
        201: ok({
          type: "object",
          properties: {
            uploadId: { type: "string" },
            mode: { type: "string", enum: ["presigned", "multipart"] },
            putUrl: { type: "string", nullable: true },
            headers: { type: "object", nullable: true },
            thumbPutUrl: { type: "string", nullable: true, description: "faqat video" },
            multipartUrl: { type: "string", nullable: true },
            expiresIn: { type: "integer", example: 600 },
          },
        }),
        403: responses.Forbidden,
        409: { description: "Tugallanmagan yuklashlar ko'p (10 ta)" },
      },
    },
  },
  "/social/uploads/{id}/complete": {
    post: {
      tags: ["Media"],
      summary: "Yuklashni yakunlash — server tekshiradi va qayta ishlaydi",
      description: "IDEMPOTENT: `ready` holatda xato bermaydi, o'sha javobni qaytaradi.",
      parameters: [idParam()],
      responses: {
        200: ok({ $ref: "#/components/schemas/Media" }),
        400: { description: "Fayl Spaces'ga yuklanmagan yoki e'lon bilan mos emas" },
        409: { description: "Allaqachon ishlatilgan" },
      },
    },
  },
  "/social/uploads/{id}/binary": {
    post: {
      tags: ["Media"],
      summary: "LOKAL DEV: faylni server orqali yuklash (multipart, maydon `file`)",
      parameters: [
        idParam(),
        { name: "thumb", in: "query", schema: { type: "string", enum: ["1"] } },
      ],
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
          },
        },
      },
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/social/media/{id}": {
    get: {
      tags: ["Media"],
      summary: "Faylni server orqali olish (zaxira yo'l, egalik tekshiruvi bilan)",
      parameters: [idParam(), { name: "thumb", in: "query", schema: { type: "string" } }],
      responses: { 200: { description: "Ikkilik fayl" }, 403: responses.Forbidden },
    },
  },

  /* ─────────────────────────── ISTORIYALAR ─────────────────────────── */
  "/social/stories/feed": {
    get: {
      tags: ["Istoriyalar"],
      summary: "Lenta — muallif bo'yicha guruhlangan aktiv istoriyalar",
      description:
        "Tartib SERVERDA: o'zim → ko'rilmaganlar (yangisi tepada) → ko'rilganlar. " +
        "Muallif ichida eskidan yangiga.",
      parameters: [
        { name: "scope", in: "query", schema: { type: "string", enum: ["all", "branch"] } },
      ],
      responses: {
        200: ok({
          type: "array",
          items: {
            type: "object",
            properties: {
              author: { $ref: "#/components/schemas/UserCard" },
              hasUnseen: { type: "boolean" },
              latestAt: { type: "string", format: "date-time" },
              stories: { type: "array", items: { $ref: "#/components/schemas/Story" } },
            },
          },
        }),
        403: responses.Forbidden,
      },
    },
  },
  "/social/stories/quota": {
    get: {
      tags: ["Istoriyalar"],
      summary: "Bugun qancha qoldi (kamera ochilishidan OLDIN chaqiriladi)",
      responses: {
        200: ok({
          type: "object",
          properties: {
            limit: { type: "integer", example: 3 },
            used: { type: "integer" },
            remaining: { type: "integer" },
            resetsAt: { type: "string", format: "date-time", description: "Toshkent yarim tuni" },
          },
        }),
      },
    },
  },
  "/social/stories": {
    post: {
      tags: ["Istoriyalar"],
      summary: "Istoriya qo'yish",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["uploadId"],
              properties: {
                uploadId: { type: "string" },
                caption: { type: "string", maxLength: 300 },
              },
            },
          },
        },
      },
      responses: {
        201: ok({ $ref: "#/components/schemas/Story" }),
        429: {
          description: "Kunlik limit — `details.code = STORY_DAILY_LIMIT`, `details.resetsAt`",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  },
  "/social/stories/{id}": {
    get: {
      tags: ["Istoriyalar"],
      summary: "Bitta istoriya (push'dan ochilganda)",
      parameters: [idParam()],
      responses: { 200: ok({ $ref: "#/components/schemas/Story" }), 404: responses.NotFound },
    },
    delete: {
      tags: ["Istoriyalar"],
      summary: "O'chirish (muallif yoki `stories.moderate`)",
      description: "Soft delete: kunlik limitda QOLADI, media 30 kundan keyin o'chadi.",
      parameters: [idParam()],
      responses: { 200: ok({ type: "object" }), 403: responses.Forbidden },
    },
  },
  "/social/stories/views": {
    post: {
      tags: ["Istoriyalar"],
      summary: "Ko'rishlar PAKETI (≤ 50), idempotent",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { storyIds: { type: "array", items: { type: "string" } } },
            },
          },
        },
      },
      responses: { 204: { description: "Qabul qilindi" } },
    },
  },
  "/social/stories/{id}/like": {
    post: {
      tags: ["Istoriyalar"],
      summary: "Layk qo'yish (idempotent)",
      parameters: [idParam()],
      responses: { 200: ok({ type: "object", properties: { liked: { type: "boolean" }, likesCount: { type: "integer" } } }) },
    },
    delete: {
      tags: ["Istoriyalar"],
      summary: "Laykni olish (idempotent)",
      parameters: [idParam()],
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/social/stories/{id}/viewers": {
    get: {
      tags: ["Istoriyalar"],
      summary: "Ko'rganlar — FAQAT muallifga",
      parameters: [idParam(), ...cursorParams],
      responses: {
        200: okList({
          type: "object",
          properties: {
            user: { $ref: "#/components/schemas/UserCard" },
            viewedAt: { type: "string", format: "date-time" },
            liked: { type: "boolean" },
          },
        }),
        403: responses.Forbidden,
      },
    },
  },
  "/social/stories/{id}/likes": {
    get: {
      tags: ["Istoriyalar"],
      summary: "Layk bosganlar — FAQAT muallifga",
      parameters: [idParam(), ...cursorParams],
      responses: { 200: okList({ type: "object" }), 403: responses.Forbidden },
    },
  },
  "/social/stories/{id}/comments": {
    get: {
      tags: ["Istoriyalar"],
      summary: "Izohlar (HAMMAGA ko'rinadi), eskidan yangiga",
      parameters: [idParam(), ...cursorParams],
      responses: { 200: okList({ type: "object" }) },
    },
    post: {
      tags: ["Istoriyalar"],
      summary: "Izoh yozish (20/daq)",
      parameters: [idParam()],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string", maxLength: 500 } },
            },
          },
        },
      },
      responses: { 201: ok({ type: "object" }), 429: responses.TooMany },
    },
  },
  "/social/stories/{id}/comments/{commentId}": {
    delete: {
      tags: ["Istoriyalar"],
      summary: "Izohni o'chirish (izoh muallifi, istoriya muallifi yoki moderator)",
      parameters: [idParam(), idParam("commentId")],
      responses: { 200: ok({ type: "object" }), 403: responses.Forbidden },
    },
  },
  "/social/users/{userId}/stories": {
    get: {
      tags: ["Istoriyalar"],
      summary: "Profil istoriyalari — odamning HAMMA istoriyalari (yangisi tepada)",
      parameters: [idParam("userId"), ...cursorParams],
      responses: { 200: okList({ $ref: "#/components/schemas/Story" }) },
    },
  },

  /* ─────────────────────────── MODERATSIYA ─────────────────────────── */
  "/social/reports": {
    post: {
      tags: ["Moderatsiya"],
      summary: "Shikoyat (takror xato bermaydi — `created: false`)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["targetType", "targetId", "reason"],
              properties: {
                targetType: { type: "string", enum: ["story", "story_comment", "message"] },
                targetId: { type: "string" },
                reason: { type: "string", maxLength: 300 },
              },
            },
          },
        },
      },
      responses: { 201: ok({ type: "object" }) },
    },
    get: {
      tags: ["Moderatsiya"],
      summary: "Shikoyatlar ro'yxati (`stories.moderate`)",
      parameters: [
        { name: "resolved", in: "query", schema: { type: "boolean" } },
        { name: "page", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer" } },
      ],
      responses: { 200: { description: "Sahifalangan ro'yxat" }, 403: responses.Forbidden },
    },
  },
  "/social/reports/{id}/resolve": {
    patch: {
      tags: ["Moderatsiya"],
      summary: "Ko'rib chiqildi (`stories.moderate`)",
      parameters: [idParam()],
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/social/users/{userId}/avatar": {
    delete: {
      tags: ["Moderatsiya"],
      summary: "Nomaqbul profil rasmini olib tashlash (`stories.moderate`)",
      parameters: [idParam("userId")],
      responses: { 200: ok({ type: "object" }), 403: responses.Forbidden },
    },
  },

  /* ─────────────────────────── CHAT ─────────────────────────── */
  "/chat/conversations": {
    get: {
      tags: ["Chat"],
      summary: "Suhbatlar ro'yxati (pinlanganlar ALOHIDA blokda)",
      parameters: [
        ...cursorParams,
        { name: "archived", in: "query", schema: { type: "boolean" } },
      ],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  pinned: { type: "array", items: { $ref: "#/components/schemas/Conversation" } },
                  items: { type: "array", items: { $ref: "#/components/schemas/Conversation" } },
                  pagination: { $ref: "#/components/schemas/CursorPagination" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/chat/direct": {
    post: {
      tags: ["Chat"],
      summary: "1:1 suhbat ochish (faqat xodim ↔ xodim)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
          },
        },
      },
      responses: { 200: ok({ $ref: "#/components/schemas/Conversation" }), 403: responses.Forbidden },
    },
  },
  "/chat/groups": {
    post: {
      tags: ["Chat"],
      summary: "Xodimlar guruhini yaratish (`chat.groupCreate`)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["title", "memberIds"],
              properties: {
                title: { type: "string", maxLength: 80 },
                memberIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      responses: { 201: ok({ $ref: "#/components/schemas/Conversation" }), 403: responses.Forbidden },
    },
  },
  "/chat/sync": {
    get: {
      tags: ["Chat"],
      summary: "Qayta ulanishda MAJBURIY sinxron",
      parameters: [{ name: "since", in: "query", schema: { type: "string", format: "date-time" } }],
      responses: {
        200: ok({
          type: "object",
          properties: {
            now: { type: "string", format: "date-time" },
            conversations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  conversation: { $ref: "#/components/schemas/Conversation" },
                  messages: { type: "array", items: { $ref: "#/components/schemas/Message" } },
                },
              },
            },
          },
        }),
      },
    },
  },
  "/chat/users": {
    get: {
      tags: ["Chat"],
      summary: "Yozish uchun xodim qidirish (o'quvchiga 403)",
      parameters: [
        { name: "q", in: "query", schema: { type: "string" } },
        { name: "page", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer" } },
      ],
      responses: { 200: { description: "Sahifalangan ro'yxat" }, 403: responses.Forbidden },
    },
  },
  "/chat/conversations/{id}": {
    patch: {
      tags: ["Chat"],
      summary: "Sozlamalar: nom, e'lon rejimi, sekin rejim",
      parameters: [idParam()],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                onlyStaffPost: { type: "boolean" },
                slowModeSec: { type: "integer", minimum: 0, maximum: 3600 },
              },
            },
          },
        },
      },
      responses: { 200: ok({ $ref: "#/components/schemas/Conversation" }) },
    },
  },
  "/chat/conversations/{id}/members": {
    get: {
      tags: ["Chat"],
      summary: "A'zolar ro'yxati",
      parameters: [idParam()],
      responses: { 200: okList({ type: "object" }) },
    },
    post: {
      tags: ["Chat"],
      summary: "A'zo qo'shish (sinf guruhida 403 — a'zolik avtomatik)",
      parameters: [idParam()],
      responses: { 200: ok({ type: "object" }), 403: responses.Forbidden },
    },
  },
  "/chat/conversations/{id}/members/{userId}": {
    delete: {
      tags: ["Chat"],
      summary: "A'zoni chiqarish",
      parameters: [idParam(), idParam("userId")],
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/chat/conversations/{id}/leave": {
    post: {
      tags: ["Chat"],
      summary: "Chiqish (sinf guruhidan chiqib bo'lmaydi)",
      parameters: [idParam()],
      responses: { 200: ok({ type: "object" }), 403: responses.Forbidden },
    },
  },
  "/chat/conversations/{id}/me": {
    patch: {
      tags: ["Chat"],
      summary: "Shaxsiy sozlamalar: ovozsiz, pin, arxiv, tarixni tozalash",
      parameters: [idParam()],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                mutedUntil: { type: "string", format: "date-time", nullable: true },
                pinned: { type: "boolean" },
                archived: { type: "boolean" },
                clearHistory: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/chat/conversations/{id}/ban": {
    post: {
      tags: ["Chat"],
      summary: "O'quvchini vaqtincha ovozsiz qilish (sinf guruhi)",
      parameters: [idParam()],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["userId", "minutes", "reason"],
              properties: {
                userId: { type: "string" },
                minutes: { type: "integer", example: 60 },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/chat/conversations/{id}/messages": {
    get: {
      tags: ["Chat"],
      summary: "Tarix (`beforeSeq` — yuqoriga, `afterSeq` — bo'shliqni to'ldirish)",
      parameters: [
        idParam(),
        { name: "beforeSeq", in: "query", schema: { type: "integer" } },
        { name: "afterSeq", in: "query", schema: { type: "integer" } },
        { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
      ],
      responses: { 200: okList({ $ref: "#/components/schemas/Message" }) },
    },
    post: {
      tags: ["Chat"],
      summary: "Xabar yuborish (IDEMPOTENT — `clientId`)",
      description: "201 — yangi xabar, 200 — allaqachon yozilgan (`created: false`).",
      parameters: [idParam()],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["clientId", "type"],
              properties: {
                clientId: { type: "string", description: "Ilova yaratgan UUID v4" },
                type: {
                  type: "string",
                  enum: ["text", "image", "video", "voice", "file", "story_reply"],
                },
                text: { type: "string", maxLength: 4000 },
                uploadId: { type: "string" },
                replyToId: { type: "string" },
                storyId: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        201: ok({ $ref: "#/components/schemas/Message" }),
        200: ok({ $ref: "#/components/schemas/Message" }, "Qayta yuborilgan xabar"),
        403: responses.Forbidden,
        429: responses.TooMany,
      },
    },
  },
  "/chat/conversations/{id}/read": {
    post: {
      tags: ["Chat"],
      summary: "O'qildi (orqaga ketmaydi)",
      parameters: [idParam()],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", required: ["seq"], properties: { seq: { type: "integer" } } },
          },
        },
      },
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/chat/messages/{id}": {
    patch: {
      tags: ["Chat"],
      summary: "Tahrirlash (muallif, 48 soat, faqat matn)",
      parameters: [idParam()],
      responses: { 200: ok({ $ref: "#/components/schemas/Message" }), 403: responses.Forbidden },
    },
    delete: {
      tags: ["Chat"],
      summary: "O'chirish (o'quvchi 10 daq, xodim 48 soat, admin har doim)",
      parameters: [idParam()],
      responses: { 200: ok({ $ref: "#/components/schemas/Message" }), 403: responses.Forbidden },
    },
  },
  "/chat/messages/{id}/readers": {
    get: {
      tags: ["Chat"],
      summary: "Kim o'qigan (guruhda)",
      parameters: [idParam()],
      responses: { 200: okList({ type: "object" }) },
    },
  },
  "/chat/class-groups/resync": {
    post: {
      tags: ["Chat"],
      summary: "Sinf guruhlarini qo'lda qayta sinxronlash (`chat.classGroupsManage`)",
      responses: { 200: ok({ type: "object" }), 403: responses.Forbidden },
    },
  },

  /* ─────────────────────────── AVATAR ─────────────────────────── */
  "/profile/avatar": {
    put: {
      tags: ["Avatar"],
      summary: "O'z rasmini yuklash (multipart, maydon `image`, ≤ 5 MB)",
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: { type: "object", properties: { image: { type: "string", format: "binary" } } },
          },
        },
      },
      responses: { 200: ok({ type: "object", properties: { avatar: { $ref: "#/components/schemas/Avatar" } } }) },
    },
    delete: {
      tags: ["Avatar"],
      summary: "Avatarni olib tashlash (bosh harflarga qaytadi)",
      responses: { 200: ok({ type: "object" }) },
    },
  },
  "/profile/avatar/preset": {
    put: {
      tags: ["Avatar"],
      summary: "Tayyor avatarni tanlash (a01 … a24)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["preset"],
              properties: { preset: { type: "string", example: "a07" } },
            },
          },
        },
      },
      responses: { 200: ok({ type: "object" }) },
    },
  },
};

const socialApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Study-Track — Istoriyalar va Chat",
    version: "1.0.0",
    description:
      "Mobil jamoa uchun API. ⚠️ To'liq matnli shartnoma (qarorlar va " +
      "sabablari bilan): `docs/social-api.md` — bu spetsifikatsiya uni " +
      "almashtirmaydi.\n\n" +
      "Socket.IO hodisalari bu yerda KO'RSATILMAYDI (OpenAPI ularni " +
      "ifodalamaydi) — ular `docs/social-api.md` §5 da.",
  },
  servers: [{ url: "/api" }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    schemas,
    responses,
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Media", description: "Yuklash: presign → PUT → complete" },
    { name: "Istoriyalar", description: "Faqat xodimlar" },
    { name: "Chat", description: "Xodimlar yozishmasi va sinf guruhlari" },
    { name: "Moderatsiya", description: "Shikoyatlar va begona kontentni o'chirish" },
    { name: "Avatar", description: "Profil rasmi" },
  ],
  paths,
};

module.exports = socialApiSpec;
