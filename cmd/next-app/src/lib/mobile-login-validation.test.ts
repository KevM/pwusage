import { describe, expect, it } from 'vitest';
import { isValidAppState } from './mobile-login-validation';

describe('isValidAppState', () => {
  it('accepts bounded base64url app states', () => {
    expect(isValidAppState('a'.repeat(22))).toBe(true);
    expect(isValidAppState('a'.repeat(128))).toBe(true);
  });

  it('rejects short, long, or non-base64url app states', () => {
    expect(isValidAppState('a'.repeat(21))).toBe(false);
    expect(isValidAppState('a'.repeat(129))).toBe(false);
    expect(isValidAppState('a'.repeat(21) + '=')).toBe(false);
  });
});
