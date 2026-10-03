/**
 * Typed HTTP errors.
 *
 * Throw these from controllers/services; the error-handler middleware turns
 * them into consistent JSON responses. Anything that is NOT an HttpError is
 * treated as an unexpected 500.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message, "BAD_REQUEST");
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string) {
    super(503, message, "SERVICE_UNAVAILABLE");
  }
}

/** Raised on purpose by the chaos middleware to simulate a broken server. */
export class ChaosError extends HttpError {
  constructor() {
    super(500, "Injected failure (chaos mode)", "CHAOS_INJECTED_FAILURE");
  }
}
