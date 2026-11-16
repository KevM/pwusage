export interface UrdbTier { rate?: number; adj?: number; sell?: number; max?: number; unit?: string }
export interface UrdbRate {
  label: string;
  name: string;
  utility: string;
  eiaid?: number;
  startdate?: number;
  enddate?: number;
  is_default?: boolean;
  supersedes?: string;
  dgrules?: string;
  energyratestructure?: UrdbTier[][];
  energyweekdayschedule?: number[][];
  energyweekendschedule?: number[][];
}
