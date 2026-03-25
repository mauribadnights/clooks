// clooks auth — token-based request authentication

import { randomBytes, timingSafeEqual } from 'crypto';

/** Generate a random auth token (32 hex chars). */
export function generateAuthToken(): string {
  return randomBytes(16).toString('hex');
}

/** Validate an auth token from request headers. */
export function validateAuth(authHeader: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return true; // No token configured = no auth required
  if (!authHeader) return false;

  // Support "Bearer <token>" format
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  // Constant-time comparison to prevent timing attacks
  if (token.length !== expectedToken.length) return false;
  const bufA = Buffer.from(token);
  const bufB = Buffer.from(expectedToken);
  return timingSafeEqual(bufA, bufB);
}
