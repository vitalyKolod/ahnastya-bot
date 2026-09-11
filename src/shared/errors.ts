export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
  ) {
    super(message);
  }
}
export class DomainError extends AppError {
  constructor(message: string) {
    super(message, 'DOMAIN_ERROR', 422);
  }
}
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}
export class PaymentError extends AppError {
  constructor(message: string) {
    super(message, 'PAYMENT_ERROR', 502);
  }
}
export class ExternalServiceError extends AppError {
  constructor(message: string) {
    super(message, 'EXTERNAL_SERVICE_ERROR', 502);
  }
}
export class TransientExternalServiceError extends ExternalServiceError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}
