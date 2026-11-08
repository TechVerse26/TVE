'use strict';
// ==========================================================================
// server/push/errors.js — one small error type for the whole push backend.
// `code` is a stable machine word the browser maps to a Bengali message;
// `message` is plain English for logs / the Setup tab.
// ==========================================================================
class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra || undefined;
  }
}

const bad = (code, message, extra) => new HttpError(400, code, message, extra);
const unauthorized = (code = 'unauthenticated', message = 'Sign in again.') => new HttpError(401, code, message);
const forbidden = (code = 'forbidden', message = 'You are not allowed to do this.') => new HttpError(403, code, message);
const notFound = (code = 'not_found', message = 'Not found.') => new HttpError(404, code, message);
const conflict = (code, message, extra) => new HttpError(409, code, message, extra);
const tooMany = (code, message, retryAfterSec) => new HttpError(429, code, message, retryAfterSec ? { retryAfter: retryAfterSec } : undefined);

module.exports = { HttpError, bad, unauthorized, forbidden, notFound, conflict, tooMany };
