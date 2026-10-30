/** Every expected failure is an AppError; anything else becomes 500 INTERNAL_ERROR. */
export interface FieldError {
  field: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors?: FieldError[],
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(errors: FieldError[], message = 'Validation failed') {
    super(400, 'VALIDATION_FAILED', message, errors);
  }
}
export class UnauthorizedError extends AppError {
  constructor(code = 'UNAUTHENTICATED', message = 'Sign in to continue') {
    super(401, code, message);
  }
}
export class PaymentRequiredError extends AppError {
  constructor(code = 'USAGE_LIMIT_EXCEEDED', message = 'Plan limit reached') {
    super(402, code, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(code = 'PERMISSION_DENIED', message = 'You do not have permission to do this') {
    super(403, code, message);
  }
}
export class NotFoundError extends AppError {
  constructor(code = 'NOT_FOUND', message = 'Not found') {
    super(404, code, message);
  }
}
export class ConflictError extends AppError {
  constructor(code = 'CONFLICT', message = 'Conflict') {
    super(409, code, message);
  }
}
export class GoneError extends AppError {
  constructor(code = 'GONE', message = 'No longer available') {
    super(410, code, message);
  }
}
export class UnprocessableError extends AppError {
  constructor(code: string, message: string, errors?: FieldError[]) {
    super(422, code, message, errors);
  }
}
export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'Too many requests. Try again later.', undefined, {
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    });
  }
}
export class NotReadyError extends AppError {
  constructor(parts: Record<string, string>) {
    super(
      503,
      'NOT_READY',
      'Service is not ready',
      Object.entries(parts).map(([field, message]) => ({ field, message })),
    );
  }
}
