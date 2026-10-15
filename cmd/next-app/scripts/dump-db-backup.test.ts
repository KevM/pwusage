import {execFile} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {expect, it} from 'vitest';

const run = promisify(execFile);
const pooler = 'postgresql://postgres.project:p%3A6543%2Fword@aws-1-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require';
const local = 'postgresql://postgres:pw@localhost:6543/postgres';
const direct = 'postgresql://postgres:pw@db.project.supabase.co:5432/postgres';

it.each([
    {kind: 'weekly', source: pooler, expected: pooler.replace('.com:6543/', '.com:5432/')},
    {kind: 'daily', source: pooler, expected: pooler.replace('.com:6543/', '.com:5432/')},
    {kind: 'pre-migration', source: pooler, expected: pooler.replace('.com:6543/', '.com:5432/')},
    {kind: 'weekly', source: local, expected: local},
    {kind: 'weekly', source: direct, expected: direct},
])('uses the maintenance connection for $kind: $source', async ({kind, source, expected}) => {
    const dir = await mkdtemp(join(tmpdir(), 'backup-connection-'));
    const log = join(dir, 'calls');
    try {
        // Exercise the real shell script, replacing only its external tools.
        await writeFile(join(dir, 'npx'), '#!/bin/sh\ncase "$*" in *db-backup-kinds*) echo "' + (kind === 'daily' ? 'small' : 'full') + '";; esac\n', {mode: 0o755});
        for (const command of ['supabase', 'psql']) {
            await writeFile(join(dir, command), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BACKUP_CALL_LOG"\n', {mode: 0o755});
        }
        await run('bash', ['scripts/dump-db-backup.sh', kind, join(dir, 'out')], {
            env: {...process.env, PATH: `${dir}:${process.env.PATH}`, DATABASE_URL: source, BACKUP_CALL_LOG: log},
        });
        const calls = (await readFile(log, 'utf8')).trim().split('\n');
        expect(calls).toHaveLength(kind === 'daily' ? 4 : 3);
        for (const call of calls) {
            expect(call).toContain(expected);
        }
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
