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
      maxlength: [32, "Username maksimal 32 ta belgidan iborat bo'lishi kerak"],
    },
    password: {
      type: String,
      required: [true, "Parol majburiy"],
      minlength: [6, "Parol kamida 6 ta belgidan iborat bo'lishi kerak"],
      maxlength: [128, "Parol maksimal 128 ta belgidan iborat bo'lishi kerak"],
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
      enum: ["owner", "teacher", "student"],
      required: [true, "Rol majburiy"],
    },
    assignedClasses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class",
      },
    ],
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

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
  return `${this.firstName} ${this.lastName}`;
});

// Remove password when converting to JSON
userSchema.set("toJSON", {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.password;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
