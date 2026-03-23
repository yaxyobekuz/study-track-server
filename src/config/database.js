const mongoose = require("mongoose");
const { config } = require("./env.config");
const logger = require("../utils/logger");

const connectDB = async () => {
  try {
    const db = await mongoose.connect(config.mongodbUri);
    logger.info(`MongoDB connected: ${db.connection.host}`);
  } catch (error) {
    logger.error(`MongoDB ulanish xatosi: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
