import { pathToFileURL } from 'node:url';

export type BackupKindConfig = { folder: string; keep: number };

// Single source of truth for where each backup goes and how many are kept.
// Every kind is a complete dump: energy history is compact day records, small
// enough to include every day. See docs/database-backups.md.
export const BACKUP_KINDS = {
    daily: { folder: 'db-backup/daily/', keep: 14 },
    weekly: { folder: 'db-backup/weekly/', keep: 8 },
    'pre-migration': { folder: 'db-backup/pre-migration/', keep: 10 },
} as const satisfies Record<string, BackupKindConfig>;

export type BackupKind = keyof typeof BACKUP_KINDS;

export function backupKind(kind: string): BackupKindConfig {
    if (!Object.hasOwn(BACKUP_KINDS, kind)) throw new Error(`Unknown backup kind: ${kind || '(empty)'}`);
    return { ...BACKUP_KINDS[kind as BackupKind] };
}

// The workflow asks for one field at a time: `tsx scripts/db-backup-kinds.ts daily folder`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const config = backupKind(process.argv[2] ?? '');
        const field = process.argv[3] as keyof BackupKindConfig;
        if (!Object.hasOwn(config, field)) throw new Error(`Unknown backup kind field: ${field ?? '(empty)'}`);
        console.log(config[field]);
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : 'Unknown backup kind');
        process.exitCode = 1;
    }
}
