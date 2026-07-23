function errorHandler(err, req, res, _next) {
  console.error('Unhandled error:', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  if (err.code === 11000) {
    return res.status(409).json({ error: 'Resource already exists' });
  }

  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler };
