const URLS = {
    'cleanup': () => process.env.BETTERSTACK_HEARTBEAT_CLEANUP,
    'check-users': () => process.env.BETTERSTACK_HEARTBEAT_CHECK_USERS,
    'restore-reserve': () => process.env.BETTERSTACK_HEARTBEAT_RESTORE_RESERVE,
} as const;

export type HeartbeatName = keyof typeof URLS;

export async function pingHeartbeat(name: HeartbeatName): Promise<void> {
    const url = URLS[name]();
    if (!url) return;
    try {
        await fetch(url, { method: 'POST' });
    } catch {
        // swallow — heartbeat failure must not break the cron
    }
}
