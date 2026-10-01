import { addDaysInSiteTimezone, getSiteMidnight } from './date-utils';

export type HistoryRetentionDays = 90 | 365;
export interface HistoryRetentionPolicy {
    history_retention_days: number | undefined;
    history_retention_grace_until: Date | string | null;
    history_retention_transition_pending: boolean | undefined;
}
export interface ValidHistoryRetentionPolicy {
    history_retention_days: HistoryRetentionDays;
    history_retention_grace_until: Date | null;
    history_retention_transition_pending: boolean;
}

export function validateRetentionDays(days: number | undefined): HistoryRetentionDays {
    if (days !== 90 && days !== 365) throw new Error('History retention must be 90 or 365 days');
    return days;
}

function validDate(date: Date): Date {
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid history retention date');
    return date;
}

export function validateHistoryRetention(policy: HistoryRetentionPolicy): ValidHistoryRetentionPolicy {
    if (typeof policy.history_retention_transition_pending !== 'boolean') {
        throw new Error('Missing history retention transition state');
    }
    return {
        history_retention_days: validateRetentionDays(policy.history_retention_days),
        history_retention_grace_until: policy.history_retention_grace_until === null
            ? null : validDate(new Date(policy.history_retention_grace_until)),
        history_retention_transition_pending: policy.history_retention_transition_pending,
    };
}

/** Evaluate with a fresh clock; never cache the effective days across grace expiry. */
export function resolveHistoryRetention(policy: HistoryRetentionPolicy, timezone: string, now: Date) {
    validDate(now);
    const validated = validateHistoryRetention(policy);
    const inGrace = validated.history_retention_grace_until !== null && now < validated.history_retention_grace_until;
    const effectiveDays: HistoryRetentionDays = validated.history_retention_days === 365 || inGrace || validated.history_retention_transition_pending ? 365 : 90;
    // Calendar-day subtraction preserves local midnight over 23/25-hour days.
    const cutoff = addDaysInSiteTimezone(getSiteMidnight(now, timezone), -effectiveDays, timezone);
    return { effectiveDays, cutoff };
}

export function changeHistoryRetention(policy: HistoryRetentionPolicy, days: number, now: Date): ValidHistoryRetentionPolicy {
    validDate(now);
    const current = validateHistoryRetention(policy);
    const target = validateRetentionDays(days);
    if (target === 365) return { history_retention_days: 365, history_retention_grace_until: null, history_retention_transition_pending: false };
    if (current.history_retention_days === 90) return current;
    return {
        history_retention_days: 90,
        history_retention_grace_until: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        history_retention_transition_pending: false,
    };
}

/** Pending is set only for the migration's existing cohort; new accounts cannot be enrolled accidentally. */
export function bootstrapHistoryRetention(policy: HistoryRetentionPolicy, noticeAt: Date): ValidHistoryRetentionPolicy {
    validDate(noticeAt);
    const current = validateHistoryRetention(policy);
    if (!current.history_retention_transition_pending || current.history_retention_days === 365) return current;
    const expiry = new Date(noticeAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    return {
        ...current,
        history_retention_transition_pending: false,
        history_retention_grace_until: current.history_retention_grace_until && current.history_retention_grace_until > expiry ? current.history_retention_grace_until : expiry,
    };
}
