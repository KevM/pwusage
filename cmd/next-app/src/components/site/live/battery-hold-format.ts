import { computeTargetReserve } from '@/lib/battery-hold-rules';

export function holdButtonLabel(soc: number): string {
  const target = computeTargetReserve(soc);
  return target === 100 ? 'Hold battery at 100% (max)' : `Hold battery at ${target}%`;
}
