const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const db = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB ulandi: ${db.connection.host}`);
  } catch (error) {
    console.error(`Xatolik: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
