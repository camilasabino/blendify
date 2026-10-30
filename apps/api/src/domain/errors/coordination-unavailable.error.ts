export class CoordinationUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';

  constructor(options?: { cause?: unknown }) {
    super('Service temporarily unavailable. Try again shortly.', options);
    this.name = 'CoordinationUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
