/**
 * Wraps async route handlers so we don't need try/catch in every controller.
 * Passes any thrown error to Express's next(err) error handler.
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;