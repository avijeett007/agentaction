import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApiError } from '../lib/errors';
import { logger } from '../logger';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  logger.error('unhandled error', {
    method: req.method,
    path: req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
};
