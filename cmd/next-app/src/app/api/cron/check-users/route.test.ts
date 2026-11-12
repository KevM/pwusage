import { describe, expect, it } from 'vitest';

import { maxDuration } from './route';

describe('check-users cron', () => {
  it('asks for the 60 s Hobby limit so the 50 s deadline can finish the run', () => {
    expect(maxDuration).toBe(60);
  });
});
