const mongoose = require("mongoose");

const dailyCoinStatSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      unique: true,
    },
    totalDistributed: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("DailyCoinStat", dailyCoinStatSchema);
