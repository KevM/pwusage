// Placeholder until the detector lands; narrowed in Task 7.
export type SolarLayoutResult = { status: 'detected' | 'low-confidence' | 'not-enough-history' | 'failed' } & Record<string, unknown>;
