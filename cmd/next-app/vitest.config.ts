
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    cacheDir: './.vitest_cache',
    test: {
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    },
});
