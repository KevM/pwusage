import { planReserve } from '@/lib/battery-hold-rules';

export function holdButtonLabel(soc: number): string {
  const plan = planReserve(soc);
  if (plan.ambiguous) {
    return 'Turn On Battery Saver…';
  }
  const target = plan.target;
  return `Turn On Battery Saver at ${holdReserveText(target)}`;
}

/** "100% (max)" for a full hold, otherwise a plain percent. */
export function holdReserveText(target: number): string {
  return target === 100 ? '100% (max)' : `${target}%`;
}

/** Copy for the dismissible notice when the restore guard left a changed reserve as-is. */
export function guardNoticeText(current: number): string {
  return `Battery Saver stopped. Your reserve was changed outside pwusage to ${current}%, so we left it as-is.`;
}
