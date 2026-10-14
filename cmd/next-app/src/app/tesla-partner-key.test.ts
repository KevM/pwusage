import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';

// Tesla fetches this at https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
// when registering the partner account (and when pairing virtual keys).
const keyUrl = new URL(
  '../../public/.well-known/appspecific/com.tesla.3p.public-key.pem',
  import.meta.url
);

describe('Tesla partner public key asset', () => {
  it('is an EC P-256 public key at the Tesla-required path', () => {
    const key = createPublicKey(readFileSync(keyUrl, 'utf8'));

    expect(key.type).toBe('public');
    expect(key.asymmetricKeyType).toBe('ec');
    expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });
});
