/**
 * Standardised API response helpers.
 * All responses follow:  { success, message, data?, errors?, meta? }
 */

const success = (res, data = {}, message = 'Success', statusCode = 200, meta = {}) => {
  const payload = { success: true, message, data };
  if (Object.keys(meta).length) payload.meta = meta;
  return res.status(statusCode).json(payload);
};

const error = (res, message = 'An error occurred', statusCode = 500, errors = null) => {
  const payload = { success: false, message };
  if (errors) payload.errors = errors;
  return res.status(statusCode).json(payload);
};

const paginated = (res, data, total, page, limit, message = 'Success') => {
  return res.status(200).json({
    success: true,
    message,
    data,
    meta: {
      total,
      page:       parseInt(page),
      limit:      parseInt(limit),
      totalPages: Math.ceil(total / limit),
      hasNext:    page * limit < total,
      hasPrev:    page > 1,
    },
  });
};

module.exports = { success, error, paginated };