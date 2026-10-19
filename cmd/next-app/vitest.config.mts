
import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    cacheDir: './.vitest_cache',
    test: {
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
        exclude: [...configDefaults.exclude, '**/.next/**', '**/.vercel/**'],
        alias: {
            '@': path.resolve(import.meta.dirname, './src')
        }
    },
});
