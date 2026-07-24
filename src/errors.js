// Uniform error contract for the React UI.
// Every non-2xx bridge response is { ok:false, error:{ code, message, details } }.

export const CODES = {
  validation_error: 400,
  unauthorized: 401,
  device_not_found: 404,
  device_unreachable: 502,
  device_error: 502,
  internal_error: 500,
};

export class ApiError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = CODES[code] ?? 500;
    this.details = details;
  }
}

export function errorBody(code, message, details = null) {
  return { ok: false, error: { code, message, details } };
}
