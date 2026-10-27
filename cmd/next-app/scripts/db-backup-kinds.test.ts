import { describe, expect, it } from 'vitest';
import { BACKUP_KINDS, backupKind } from './db-backup-kinds';

describe('database backup kinds', () => {
    it('maps each kind to its own folder and retention', () => {
        expect(backupKind('daily')).toEqual({ folder: 'db-backup/daily/', keep: 14, keepWeekly: 8 });
        expect(() => backupKind('weekly')).toThrow('Unknown backup kind');
        expect(backupKind('pre-migration')).toEqual({ folder: 'db-backup/pre-migration/', keep: 10 });
    });

    it('rejects unknown kinds instead of defaulting to one', () => {
        expect(() => backupKind('hourly')).toThrow('Unknown backup kind');
        expect(() => backupKind('')).toThrow('Unknown backup kind');
        expect(() => backupKind('__proto__')).toThrow('Unknown backup kind');
    });

    it('never lets one folder contain another kind or the legacy root backups', () => {
        const folders = Object.values(BACKUP_KINDS).map((kind) => kind.folder);
        for (const folder of folders) {
            expect(folder).toMatch(/^db-backup\/[a-z-]+\/$/);
            for (const other of folders) {
                if (other !== folder) expect(other.startsWith(folder)).toBe(false);
            }
        }
    });
});
