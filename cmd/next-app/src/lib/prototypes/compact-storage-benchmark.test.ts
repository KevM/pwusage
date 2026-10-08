import { expect, it } from 'vitest';
import { measureStorage } from './compact-storage-benchmark';
it.each(['postgresql://production.example/db', '/tmp', '/private/tmp/compact-energy-pg-../production'])('rejects a non-disposable storage target before opening a connection: %s', async target => {
    await expect(measureStorage([], target)).rejects.toThrow('Storage target must be a private disposable local socket');
});
