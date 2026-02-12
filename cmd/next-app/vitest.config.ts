
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    cacheDir: './.vitest_cache',
    test: {
        environment: 'node',
        alias: {
            '@': path.resolve(__dirname, './src')
        }
    },
});
