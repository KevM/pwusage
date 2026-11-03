import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const helper = resolve('scripts/dev-history-common.sh');

describe('dev history snapshot path safety', () => {
    let work: string;
    let repo: string;

    beforeEach(async () => {
        work = await mkdtemp(join(tmpdir(), 'dev-history-path-'));
        repo = join(work, 'repo');
        execFileSync('git', ['init', '--quiet', repo]);
        await writeFile(join(repo, '.gitignore'), 'snapshots/\n');
    });
    afterEach(async () => { await rm(work, { recursive: true, force: true }); });

    function check(path: string) {
        return spawnSync('bash', ['-c', 'source "$1"; dev_history_refuse_tracked_path "$2"',
            'bash', helper, path], { cwd: repo, encoding: 'utf8' });
    }

    it.each(['./new-backups/site', 'new/backups/site', '.env-snapshot'])('refuses unignored path %s', (path) => {
        const result = check(path);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('inside a git work tree and not ignored');
    });

    it('refuses an absolute path with nonexistent parents inside the repository', () => {
        expect(check(join(repo, 'new', 'backups', 'site')).status).toBe(1);
    });

    it.each(['snapshots/site', './snapshots/new/site'])('allows ignored path %s before its parents exist', (path) => {
        expect(check(path).status).toBe(0);
    });

    it('allows a path outside the repository before its parents exist', () => {
        expect(check(join(work, 'private', 'new', 'site')).status).toBe(0);
    });
});
