import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const WORKFLOWS = '../../.github/workflows';
const DEV_ONLY_SCRIPTS = ['assert-dev-database.sql', 'load-dev-energy-data.sql', 'sanitize-dev-copy.sql', 'prune-dev-copy.sql', 'check-dev-database-url.sh'];

// Splits a workflow into top-level jobs, and a job into its steps. Indentation
// follows the repo's workflows: jobs at two spaces, steps at six.
function jobs(workflow: string): Record<string, string> {
    const body = workflow.split(/^jobs:\s*$/m)[1] ?? '';
    const result: Record<string, string> = {};
    for (const chunk of body.split(/^(?=  [\w-]+:\s*$)/m)) {
        const name = chunk.match(/^  ([\w-]+):\s*$/m)?.[1];
        if (name) result[name] = chunk;
    }
    return result;
}
const steps = (job: string) => job.split(/^(?=      - )/m).slice(1);
const stepNamed = (job: string, name: string) => {
    const step = steps(job).find((s) => s.includes(`name: ${name}\n`));
    if (!step) throw new Error(`No step named ${name}`);
    return step;
};
const stepIndex = (job: string, name: string) => steps(job).indexOf(stepNamed(job, name));

const workflowFiles = readdirSync(WORKFLOWS).filter((file) => /\.ya?ml$/.test(file));
const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');
const verifyDb = jobs(ci)['verify-db'];

describe('dev-only database scripts stay away from prod', () => {
    it('no migration mentions the dev marker schema', () => {
        for (const dir of ['db-migrations', 'supabase/migrations']) {
            if (!existsSync(dir)) continue;
            for (const file of readdirSync(dir)) {
                expect(readFileSync(join(dir, file), 'utf8'), `${dir}/${file}`).not.toMatch(/pwusage_env/i);
            }
        }
    });

    it('only the dev verification job references the dev-only scripts', () => {
        for (const file of workflowFiles) {
            for (const [name, job] of Object.entries(jobs(readFileSync(join(WORKFLOWS, file), 'utf8')))) {
                if (file === 'ci.yml' && name === 'verify-db') continue;
                for (const script of DEV_ONLY_SCRIPTS) expect(job, `${file} job ${name}`).not.toContain(script);
            }
        }
    });

    it('re-runs the dev copy in any PR that changes it, without gating prod jobs on that', () => {
        const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');
        const filter = jobs(ci)['check-db-changes'];
        expect(filter).toContain("- 'cmd/next-app/scripts/*-dev-*'");
        expect(filter).toContain("- '.github/workflows/ci.yml'");
        // Every script the copy runs falls under that glob.
        for (const script of [...DEV_ONLY_SCRIPTS, 'export-dev-energy-data.sql']) {
            expect(verifyDb, script).toContain(script);
            expect(script).toMatch(/^[^/]*-dev-[^/]*$/);
        }
        expect(verifyDb).toMatch(/outputs\.migrations == 'true' \|\| needs\.check-db-changes\.outputs\.dev_copy == 'true'/);
        for (const [name, job] of Object.entries(jobs(ci))) {
            if (name !== 'verify-db') expect(job, name).not.toContain('needs.check-db-changes.outputs.dev_copy');
        }
    });

    it('every verify-db step that writes to dev is given only the dev URL', () => {
        for (const step of steps(verifyDb)) {
            if (!DEV_ONLY_SCRIPTS.some((script) => step.includes(script)) && !step.includes('DEV_DATABASE_URL')) continue;
            if (step.includes('check-dev-database-url.sh')) continue;
            expect(step).toContain('secrets.DEV_DATABASE_URL');
            expect(step).not.toContain('secrets.DATABASE_URL');
        }
    });

    it('checks the secrets before any step touches a database', () => {
        const check = stepIndex(verifyDb, 'Check dev and prod databases differ');
        expect(stepNamed(verifyDb, 'Check dev and prod databases differ')).toContain('bash scripts/check-dev-database-url.sh');
        expect(check).toBeLessThan(stepIndex(verifyDb, 'Dump Production DB'));
        expect(check).toBeLessThan(stepIndex(verifyDb, 'Restore to Dev DB'));
    });

    it('runs the dev guard before the restore drops the public schema', () => {
        const restore = stepNamed(verifyDb, 'Restore to Dev DB');
        const guard = restore.indexOf('-f scripts/assert-dev-database.sql');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(restore.indexOf('DROP SCHEMA public CASCADE'));
        // The first psql command in the step is the guard.
        expect(restore.indexOf('psql')).toBe(restore.indexOf('psql -X -v ON_ERROR_STOP=1 "$DEV_DATABASE_URL" -f scripts/assert-dev-database.sql'));
    });

    it('restores data, the day-record subset and the scrub in one transaction that stops on errors', () => {
        expect(stepNamed(verifyDb, 'Restore to Dev DB')).toMatch(
            /psql -X --single-transaction -v ON_ERROR_STOP=1 "\$DEV_DATABASE_URL" -f data\.sql -f scripts\/load-dev-energy-data\.sql -f scripts\/sanitize-dev-copy\.sql$/m,
        );
    });

    it('downloads only the energy history subset dev keeps, not the full history', () => {
        const dump = stepNamed(verifyDb, 'Dump Production DB');
        const data = dump.split('\n').find((line) => line.includes('-f data.sql'));
        // Unquoted: the CLI reads -x as a CSV list. Day records come from the export instead;
        // EnergyData stays excluded for a production copy taken before it is dropped.
        const excluded = data?.match(/ -x (\S+)/)?.[1].split(',').sort();
        expect(excluded).toEqual(['public.EnergyData', 'public.EnergyDayArchive', 'public.EnergyDaySummary']);
        expect(dump).toMatch(/-f scripts\/export-dev-energy-data\.sql$/m);
        // Exported first, so every Site and Tariff a row references is already in data.sql.
        expect(dump.indexOf('export-dev-energy-data.sql')).toBeLessThan(dump.indexOf('-f data.sql'));
    });

    it('keeps the export read-only and unguarded, since it runs against prod', () => {
        const exportSql = readFileSync('scripts/export-dev-energy-data.sql', 'utf8').replace(/--.*$/gm, '');
        expect(exportSql).not.toContain('assert-dev-database');
        expect(exportSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i);
    });

    it('exports the same day-record window that the prune keeps', () => {
        const windowOf = (file: string) => readFileSync(file, 'utf8').match(/interval '(\d+ days)'/)?.[1];
        expect(windowOf('scripts/export-dev-energy-data.sql')).toBeDefined();
        expect(windowOf('scripts/export-dev-energy-data.sql')).toBe(windowOf('scripts/prune-dev-copy.sql'));
    });

    it('copies only public data, keeping managed Supabase tables out of dev restores', () => {
        const dump = stepNamed(verifyDb, 'Dump Production DB');
        const data = dump.split('\n').find((line) => line.includes('-f data.sql'));
        expect(data).toMatch(/--schema public(?:\s|$)/);
        expect(dump).toContain('--schema supabase_migrations');
    });

    it('also excludes managed Supabase tables from backup data', () => {
        const script = readFileSync('scripts/dump-db-backup.sh', 'utf8');
        const dumps = script.split('\n').filter((line) => line.trimStart().startsWith('supabase db dump') && line.includes('--data-only'));
        expect(dumps).toHaveLength(1);
        for (const dump of dumps) expect(dump).toMatch(/--schema public(?:\s|$)/);
    });

    it('prunes only after migrations ran', () => {
        const prune = stepIndex(verifyDb, 'Prune Dev Copy');
        expect(stepNamed(verifyDb, 'Prune Dev Copy')).toContain('-f scripts/prune-dev-copy.sql');
        expect(prune).toBeGreaterThan(stepIndex(verifyDb, 'Run Migrations on Dev'));
    });

    it('runs the isolated PostgreSQL tests for these scripts in CI', () => {
        expect(jobs(ci).test).toContain('npm run test:dev-copy:postgres');
    });
});

describe('check-dev-database-url.sh', () => {
    const pooler = (ref: string, password = 'pw') => `postgresql://postgres.${ref}:${password}@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;
    const direct = (ref: string, password = 'pw') => `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres`;

    async function check(env: Record<string, string>) {
        const base = { ...process.env };
        delete base.DATABASE_URL;
        delete base.DEV_DATABASE_URL;
        try {
            const result = await run('bash', ['scripts/check-dev-database-url.sh'], { env: { ...base, ...env } });
            return { code: 0, out: result.stdout + result.stderr };
        } catch (error) {
            const failed = error as { code: number; stdout: string; stderr: string };
            return { code: failed.code, out: failed.stdout + failed.stderr };
        }
    }

    it('passes when dev and prod are different projects', async () => {
        const result = await check({ DATABASE_URL: pooler('prodref111'), DEV_DATABASE_URL: pooler('devref2222') });
        expect(result.code, result.out).toBe(0);
    });

    it.each([
        ['pooler', 'pooler', pooler('sameref333', 'a'), pooler('sameref333', 'b')],
        ['pooler', 'direct', pooler('sameref333'), direct('sameref333')],
        ['direct', 'pooler', direct('sameref333'), pooler('sameref333')],
    ])('refuses when prod (%s) and dev (%s) are the same project', async (_p, _d, prod, dev) => {
        const result = await check({ DATABASE_URL: prod, DEV_DATABASE_URL: dev });
        expect(result.code).not.toBe(0);
        expect(result.out).toContain('same Supabase project');
    });

    it.each([
        ['dev is missing', { DATABASE_URL: pooler('prodref111') }],
        ['prod is missing', { DEV_DATABASE_URL: pooler('devref2222') }],
        ['dev has no project ref', { DATABASE_URL: pooler('prodref111'), DEV_DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/postgres' }],
        ['the URLs are identical', { DATABASE_URL: 'postgresql://u:p@h/db', DEV_DATABASE_URL: 'postgresql://u:p@h/db' }],
    ])('fails closed when %s', async (_label, env) => {
        expect((await check(env)).code).not.toBe(0);
    });

    it('never prints either URL', async () => {
        const prod = pooler('sameref333', 'prod-secret');
        const dev = direct('sameref333', 'dev-secret');
        const results = [await check({ DATABASE_URL: prod, DEV_DATABASE_URL: dev }),
            await check({ DATABASE_URL: pooler('prodref111', 'prod-secret'), DEV_DATABASE_URL: pooler('devref2222', 'dev-secret') })];
        for (const { out } of results) {
            expect(out).not.toContain('secret');
            expect(out).not.toContain('sameref333');
            expect(out).not.toContain('prodref111');
        }
    });
});
