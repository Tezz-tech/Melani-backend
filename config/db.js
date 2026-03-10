const mongoose = require('mongoose');
const logger   = require('../utils/logger');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS:          45000,
    });

    logger.info(`MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected — retrying...'));
    mongoose.connection.on('reconnected',  () => logger.info('MongoDB reconnected'));
    mongoose.connection.on('error',        (err) => logger.error('MongoDB error:', err));
  } catch (err) {
    logger.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;