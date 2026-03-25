import { describe, it, expect } from 'vitest';
import { generateAuthToken, validateAuth } from '../src/auth.js';

describe('generateAuthToken', () => {
  it('generates a 32-character hex string', () => {
    const token = generateAuthToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique tokens each time', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateAuthToken());
    }
    expect(tokens.size).toBe(100);
  });
});

describe('validateAuth', () => {
  const token = 'abc123def456abc123def456abc123de';

  it('returns true when no expected token (no auth required)', () => {
    expect(validateAuth(undefined, '')).toBe(true);
    expect(validateAuth('anything', '')).toBe(true);
  });

  it('returns false when expected token set but no header', () => {
    expect(validateAuth(undefined, token)).toBe(false);
  });

  it('validates raw token in header', () => {
    expect(validateAuth(token, token)).toBe(true);
  });

  it('validates Bearer token format', () => {
    expect(validateAuth(`Bearer ${token}`, token)).toBe(true);
  });

  it('rejects wrong token', () => {
    expect(validateAuth('wrong-token-value-xxxxxxxxxxxxx', token)).toBe(false);
  });

  it('rejects token of different length', () => {
    expect(validateAuth('short', token)).toBe(false);
  });

  it('rejects Bearer with wrong token', () => {
    expect(validateAuth('Bearer wrong-token-xxxxxxxxxxxxx', token)).toBe(false);
  });

  it('is timing-safe (does not short-circuit on length match)', () => {
    // This is a structural test — we can't truly measure timing, but we verify
    // that the function handles same-length different tokens correctly
    const a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(validateAuth(a, b)).toBe(false);
  });
});
