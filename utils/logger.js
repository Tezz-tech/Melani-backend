const winston = require('winston');
const path    = require('path');
const fs      = require('fs');
const { combine, timestamp, printf, colorize, errors } = winston.format;

const logDir = process.env.NODE_ENV === 'production' ? '/tmp/logs' : path.join(__dirname, 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack }) =>
    `${timestamp} [${level}] ${stack || message}`
  )
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level:      process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  format:     process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level:    'error',
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
    }),
  ],
});

module.exports = logger;