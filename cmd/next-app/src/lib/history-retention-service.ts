import { EnergyRepo } from './energy-repo';
import { LoadTagRepo } from './load-tag-repo';
import { HistoryRetentionRepo, type RetentionSite } from './history-retention-repo';
import { resolveHistoryRetention } from './history-retention';

interface CleanupSite {
    siteId: string; userId: string; configuredDays: number; effectiveDays: number;
    graceUntil: string | null; transitionPending: boolean; cutoff: string; eligibleEnergy: number; eligibleTags: number;
    deletedEnergy: number; deletedTags: number;
}
interface RetentionReport {
    asOf: string; enabled: boolean; disabledReason?: string; sites: CleanupSite[];
    skippedSites: string[]; batches: number; workRemaining: boolean;
    deleted: { energy: number; tags: number };
}
interface ServiceDeps {
    repo: Pick<HistoryRetentionRepo, 'listSites' | 'preview' | 'withLockedSite'>;
    energy: Pick<EnergyRepo, 'deleteExpiredBatch'>;
    tags: Pick<LoadTagRepo, 'deleteExpiredBatch'>;
}

export class HistoryRetentionService {
    private deps: ServiceDeps;
    constructor(deps?: ServiceDeps) { this.deps = deps ?? { repo: new HistoryRetentionRepo(), energy: new EnergyRepo(), tags: new LoadTagRepo() }; }

    private target(site: RetentionSite, now: Date): CleanupSite | null {
        if (!site.userId) return null;
        if (!site.policy) throw new Error('Missing retention entitlement');
        const { effectiveDays, cutoff } = resolveHistoryRetention(site.policy, site.timezone, now);
        return { siteId: site.siteId, userId: site.userId, configuredDays: site.policy.history_retention_days,
            effectiveDays, graceUntil: site.policy.history_retention_grace_until?.toISOString() ?? null, transitionPending: site.policy.history_retention_transition_pending,
            cutoff: cutoff.toISOString(), eligibleEnergy: 0, eligibleTags: 0, deletedEnergy: 0, deletedTags: 0 };
    }

    async run(options: { now?: Date; apply?: boolean; batchSize?: number; maxBatches?: number; maxTimeMs?: number } = {}): Promise<RetentionReport> {
        const now = options.now ?? new Date();
        const batchSize = options.batchSize ?? 1000;
        const maxBatches = options.maxBatches ?? 50;
        const maxTimeMs = options.maxTimeMs ?? 35000;
        if (!Number.isFinite(now.getTime()) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000 || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000 || !Number.isFinite(maxTimeMs) || maxTimeMs < 1 || maxTimeMs > 45000) throw new Error('Invalid retention cleanup budget');
        const deadline = Date.now() + maxTimeMs;
        const allSites = await this.deps.repo.listSites();
        // Validate the entire cohort before counting or deleting anything.
        const sites: CleanupSite[] = [];
        const skippedSites: string[] = [];
        for (const site of allSites) {
            const target = this.target(site, now);
            if (target) sites.push(target); else skippedSites.push(site.siteId);
        }
        const counts = await this.deps.repo.preview(sites);
        const byId = new Map(counts.map(count => [count.siteId, count]));
        for (const site of sites) {
            const count = byId.get(site.siteId);
            if (!count) throw new Error('Missing retention preview count');
            site.eligibleEnergy = count.energy; site.eligibleTags = count.tags;
        }
        const transitionPending = sites.some(site => site.transitionPending);
        const report: RetentionReport = { asOf: now.toISOString(), enabled: options.apply === true && !transitionPending,
            disabledReason: transitionPending ? 'Existing-account transition bootstrap is incomplete' : options.apply ? undefined : 'Preview only',
            sites, skippedSites, batches: 0, workRemaining: sites.some(site => site.eligibleEnergy + site.eligibleTags > 0), deleted: { energy: 0, tags: 0 } };
        if (!report.enabled) return report;

        const queue = sites.filter(site => site.eligibleEnergy + site.eligibleTags > 0)
            .map(site => ({ site, energy: site.eligibleEnergy, tags: site.eligibleTags }));
        while (queue.length && report.batches < maxBatches && Date.now() < deadline) {
            // Unserved sites accumulate backlog and rise in priority on the next run.
            queue.sort((a, b) => (b.energy + b.tags) - (a.energy + a.tags));
            const candidate = queue.shift();
            if (!candidate) break;
            const site = candidate.site;
            const batch = await this.deps.repo.withLockedSite(site.siteId, async (locked, db) => {
                if (!locked) { if (!skippedSites.includes(site.siteId)) skippedSites.push(site.siteId); return { energy: 0, tags: 0 }; }
                const target = this.target(locked, now);
                if (!target) { if (!skippedSites.includes(site.siteId)) skippedSites.push(site.siteId); return { energy: 0, tags: 0 }; }
                if (target.transitionPending) throw new Error('Account transition is incomplete');
                site.graceUntil = target.graceUntil; site.userId = target.userId; site.cutoff = target.cutoff; site.configuredDays = target.configuredDays; site.effectiveDays = target.effectiveDays;
                const energy = await this.deps.energy.deleteExpiredBatch(site.siteId, new Date(target.cutoff), batchSize, db);
                const tags = await this.deps.tags.deleteExpiredBatch(site.siteId, new Date(target.cutoff), batchSize, db);
                return { energy, tags };
            }, Math.max(1, Math.min(5000, deadline - Date.now())));
            site.deletedEnergy += batch.energy; site.deletedTags += batch.tags;
            report.deleted.energy += batch.energy; report.deleted.tags += batch.tags; report.batches++;
            candidate.energy = Math.max(0, candidate.energy - batch.energy);
            candidate.tags = Math.max(0, candidate.tags - batch.tags);
            if (batch.energy + batch.tags > 0 && candidate.energy + candidate.tags > 0) queue.push(candidate);
        }
        // Use the final cutoffs, including any concurrent entitlement changes.
        const remaining = await this.deps.repo.preview(sites.filter(site => !skippedSites.includes(site.siteId)));
        report.workRemaining = remaining.some(count => count.energy + count.tags > 0);
        return report;
    }
}
