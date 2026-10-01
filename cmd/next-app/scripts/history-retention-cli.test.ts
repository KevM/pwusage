import { describe, expect, it } from 'vitest';
import { parseRetentionArgs, assertRetentionTarget, parseRetentionAuditArgs } from './history-retention-cli';

describe('retention maintenance CLI', () => {
    it('defaults to preview and requires an explicit account, environment, and valid tier', () => {
        expect(parseRetentionArgs(['--env', 'dev', '--user', 'u1', '--days', '365'])).toEqual({ environment: 'dev', userId: 'u1', days: 365, apply: false });
        for (const args of [[], ['--user', 'u1', '--days', '90'], ['--env', 'dev', '--user', 'u1', '--days', '180'], ['--env', 'dev', '--user', 'u1', '--days', '90', '--typo']]) {
            expect(() => parseRetentionArgs(args)).toThrow();
        }
    });
    it('requires the bootstrap cohort and recorded notice independently of tier assignment', () => {
        expect(parseRetentionArgs(['--env', 'dev', '--cohort', 'cohort.json', '--notice-at', '2026-10-01T18:00:00Z']).apply).toBe(false);
        expect(() => parseRetentionArgs(['--env', 'dev', '--cohort', 'cohort.json', '--notice-at', 'bad'])).toThrow();
        expect(() => parseRetentionArgs(['--env', 'dev', '--cohort', 'cohort.json', '--notice-at', '2026-10-01T18:00:00Z', '--apply'])).toThrow('notice');
        expect(() => parseRetentionArgs(['--env', 'dev', '--cohort', 'cohort.json', '--notice-at', '2026-10-01T18:00:00Z', '--days', '90'])).toThrow();
    });
    it('allows only read-only audit arguments with an explicit target', () => {
        expect(parseRetentionAuditArgs(['--env', 'dev'])).toEqual({ environment: 'dev' });
        expect(parseRetentionAuditArgs(['--env', 'prod', '--as-of', '2026-11-01T00:00:00Z']).asOf).toEqual(new Date('2026-11-01T00:00:00Z'));
        expect(() => parseRetentionAuditArgs(['--env', 'dev', '--apply'])).toThrow();
        expect(() => parseRetentionAuditArgs(['--env', 'dev', '--as-of', 'bad'])).toThrow();
    });
    it('refuses environment mismatches without exposing credentials', () => {
        assertRetentionTarget('dev', 'postgresql://postgres.aipxozppjmijrpwyuvuo:secret@aws-0.pooler.supabase.com/postgres');
        assertRetentionTarget('prod', 'postgresql://postgres:secret@db.gaflounoibsubfoducqz.supabase.co/postgres');
        assertRetentionTarget('local', 'postgresql://postgres@localhost/test');
        expect(() => assertRetentionTarget('dev', 'postgresql://postgres:secret@db.gaflounoibsubfoducqz.supabase.co/postgres')).toThrow('does not match');
        expect(() => assertRetentionTarget('local', 'postgresql://localhost.attacker.com/test')).toThrow();
        expect(() => assertRetentionTarget('dev', undefined)).toThrow('DATABASE_URL');
    });
});
