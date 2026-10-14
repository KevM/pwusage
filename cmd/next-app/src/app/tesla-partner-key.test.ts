import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

describe('Tesla partner public key asset', () => {
  const keyPath = path.resolve(
    process.cwd(),
    'public/.well-known/appspecific/com.tesla.3p.public-key.pem'
  );

  it('exists in the public directory at the Tesla-required path', () => {
    expect(fs.existsSync(keyPath)).toBe(true);
  });

  it('contains a valid EC P-256 public key in PEM format', () => {
    const pem = fs.readFileSync(keyPath, 'utf8');
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----END PUBLIC KEY-----');

    const key = crypto.createPublicKey(pem);
    expect(key.asymmetricKeyType).toBe('ec');
    expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });

  it('matches the registered Tesla developer application public key', () => {
    const pem = fs.readFileSync(keyPath, 'utf8').trim();
    const expected = [
      '-----BEGIN PUBLIC KEY-----',
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPwdsXNKz3gHKy3iVv/UEHOqqfa4p',
      'IpXah0BzotA/nWrlwIKuVXQ3buwKDH3NBJEb6LLb7HTojtC0f9LwPdxK2Q==',
      '-----END PUBLIC KEY-----',
    ].join('\n');

    expect(pem).toBe(expected);
  });
});
