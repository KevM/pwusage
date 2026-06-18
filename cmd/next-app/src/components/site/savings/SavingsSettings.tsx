'use client';
import { useState } from 'react';
import type { SiteRoiConfig } from '@/lib/db';
import type { ComparisonPlan } from '@/lib/roi/comparison-tariff-repo';
import { RoiConfigForm } from '@/components/site/RoiConfigForm';
import { ComparisonTariffEditor } from '@/components/site/ComparisonTariffEditor';
import { MeteredTariffEditor, type MeteredVersionSummary } from '@/components/site/MeteredTariffEditor';

export function SavingsSettings({
  siteId,
  roiConfig,
  comparisonPlans,
  meteredPlanName,
  meteredPlanVersion,
  meteredVersions,
  defaultOpen,
}: {
  siteId: string;
  roiConfig: SiteRoiConfig | null;
  comparisonPlans: ComparisonPlan[];
  meteredPlanName: string;
  meteredPlanVersion?: number | null;
  meteredVersions: MeteredVersionSummary[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="space-y-4">
      <button
        type="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm font-medium text-foreground/80 hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-bg-base dark:ring-offset-slate-900 rounded px-1 -mx-1"
        aria-expanded={open}
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        ⚙️ Savings settings
      </button>
      {open && (
        <div className="space-y-6">
          <RoiConfigForm siteId={siteId} initial={roiConfig} />
          <ComparisonTariffEditor siteId={siteId} plans={comparisonPlans} meteredPlanName={meteredPlanName} meteredPlanVersion={meteredPlanVersion} />
          <MeteredTariffEditor siteId={siteId} versions={meteredVersions} />
        </div>
      )}
    </div>
  );
}
