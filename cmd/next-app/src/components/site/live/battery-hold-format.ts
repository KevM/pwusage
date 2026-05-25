import { computeTargetReserve } from '@/lib/battery-hold-rules';

export function holdButtonLabel(soc: number): string {
  const target = computeTargetReserve(soc);
  return target === 100 ? 'Hold battery at 100% (max)' : `Hold battery at ${target}%`;
}

/** "100% (max)" for a full hold, otherwise a plain percent. */
export function holdReserveText(target: number): string {
  return target === 100 ? '100% (max)' : `${target}%`;
}

/** Copy for the dismissible notice when the restore guard left a changed reserve as-is. */
export function guardNoticeText(current: number): string {
  return `Hold cancelled — your reserve is set to ${current}% (changed outside the app), so we left it as-is.`;
}
