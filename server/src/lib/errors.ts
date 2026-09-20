/** Errors that are safe to show the caller. Anything else becomes a 500. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = 'Unauthorized', code = 'unauthorized') {
    return new ApiError(401, code, message);
  }
  static forbidden(message: string, code = 'forbidden') {
    return new ApiError(403, code, message);
  }
  static notFound(message: string, code = 'not_found') {
    return new ApiError(404, code, message);
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message);
  }
  static tooMany(message = 'Too many requests') {
    return new ApiError(429, 'rate_limited', message);
  }
}
