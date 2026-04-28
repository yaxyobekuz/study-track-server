// Bcrypt
const bcrypt = require("bcrypt");

// Mongoose
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "Username majburiy"],
      unique: true,
      trim: true,
      lowercase: true,
      minlength: [3, "Username kamida 3 ta belgidan iborat bo'lishi kerak"],
      maxlength: [32, "Username maksimal 32 ta belgidan iborat bo'lishi kerak"],
      match: [
        /^[a-z0-9._]+$/,
        "Username faqat lotin harflari, raqamlar, nuqta va pastki chiziqdan iborat bo'lishi kerak",
      ],
    },
    password: {
      type: String,
      required: [true, "Parol majburiy"],
      minlength: [6, "Parol kamida 6 ta belgidan iborat bo'lishi kerak"],
      maxlength: [128, "Parol maksimal 128 ta belgidan iborat bo'lishi kerak"],
    },
    plainPassword: {
      type: String,
      select: false,
    },
    firstName: {
      type: String,
      required: [true, "Ism majburiy"],
      maxlength: [128, "Ism maksimal 128 ta belgidan iborat bo'lishi kerak"],
      trim: true,
    },
    telegramIds: [
      {
        trim: true,
        type: String,
        minlength: [3, "Telegram ID formati noto'g'ri"],
        maxlength: [20, "Telegram ID formati noto'g'ri"],
      },
    ],
    lastName: {
      type: String,
      trim: true,
      maxlength: [
        128,
        "Familiya maksimal 128 ta belgidan iborat bo'lishi kerak",
      ],
    },
    role: {
      type: String,
      required: [true, "Rol majburiy"],
    },
    classes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Class" }],
    isActive: {
      type: Boolean,
      default: true,
    },
    gender: {
      type: String,
      enum: ["male", "female", null],
      default: null,
    },
    coinBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    penaltyPoints: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Davomat uchun ish jadvali override (null = roldan meros oladi)
    workStartTime: {
      type: String,
      default: null,
      match: [
        /^([01]\d|2[0-3]):[0-5]\d$/,
        "Ish boshlanish vaqti HH:MM formatida bo'lishi kerak",
      ],
    },
    workEndTime: {
      type: String,
      default: null,
      match: [
        /^([01]\d|2[0-3]):[0-5]\d$/,
        "Ish tugash vaqti HH:MM formatida bo'lishi kerak",
      ],
    },
    // null = roldan meros oladi (bo'sh array null sifatida qaraladi)
    workDays: {
      type: [Number],
      default: undefined,
      validate: {
        validator: function (arr) {
          if (!arr || arr.length === 0) return true;
          return arr.every((d) => d >= 0 && d <= 6);
        },
        message: "Ish kunlari 0-6 orasida bo'lishi kerak",
      },
    },
    // Haftalik jadval: har bir kun uchun alohida vaqt (ixtiyoriy override)
    // Key: hafta kuni (0-6), Value: { startTime: "HH:MM", endTime: "HH:MM" }
    weeklySchedule: {
      type: Map,
      of: new (require("mongoose").Schema)(
        {
          startTime: {
            type: String,
            match: [/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM formatida bo'lishi kerak"],
          },
          endTime: {
            type: String,
            match: [/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM formatida bo'lishi kerak"],
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    // Premium subscription
    premium: {
      isActive: {
        type: Boolean,
        default: false,
        index: true,
      },
      expiresAt: {
        type: Date,
        default: null,
      },
    },
    profilePicture: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Image",
      default: null,
    },
    emojiBadgeId: {
      type: Number,
      default: null,
      min: 1,
    },
    displayName: {
      type: String,
      trim: true,
      maxlength: [48, "Ko'rsatma ismi maksimal 48 ta belgidan iborat bo'lishi kerak"],
      default: null,
    },
    nameColor: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Validate role against Role collection
userSchema.pre("validate", async function (next) {
  if (this.isModified("role")) {
    const Role = require("./role.model");
    const exists = await Role.findOne({ value: this.role });
    if (!exists) {
      return next(new Error("Noto'g'ri rol qiymati"));
    }
  }
  next();
});

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  // Save plain password before hashing
  this.plainPassword = this.password;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare entered password with hashed password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Virtual field - full name
userSchema.virtual("fullName").get(function () {
  return this.lastName ? `${this.firstName} ${this.lastName}` : this.firstName;
});

// Remove password when converting to JSON
userSchema.set("toJSON", {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.password;
    delete ret.plainPassword;
    return ret;
  },
});

// Indexes for better query performance
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ classes: 1 });

// POST-SAVE HOOK: Create WeeklyStats for new student
userSchema.post("save", async function (doc) {
  // Only for new students
  if (this.isNew && this.role === "student") {
    try {
      const { createWeeklyStatsForStudent } = require("../services/weeklystats.service");
      const { getCurrentWeekRange } = require("../helpers/statistics.helpers");
      const { weekNumber, year } = getCurrentWeekRange();

      // Create stats for current week
      await createWeeklyStatsForStudent(this._id, weekNumber, year);

      require("../utils/logger").info(`WeeklyStats yaratildi yangi o'quvchi uchun: ${this._id}`);
    } catch (error) {
      require("../utils/logger").error("Yangi o'quvchi uchun WeeklyStats yaratishda xato:", error);
      // Don't throw - user is already created
    }
  }
});

module.exports = mongoose.model("User", userSchema);
