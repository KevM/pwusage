import type { Importer } from './importer';
import type { EnergySiteInfo, FleetProduct, TeslaClient } from './tesla-client';
import { createTeslaClientForUser } from './tesla-client-factory';
import { logEvent } from './observability';
import { SiteMembershipJoinRepo, type HardwareMember } from './site-membership-join-repo';
import { SiteRepo } from './site-repo';

type LoginClient = Pick<TeslaClient, 'getEnergySiteInfo'>;
type LoginImporter = Pick<Importer, 'ensureSite'>;

function usable(member: HardwareMember): boolean {
    return member.is_active === true && Boolean(member.refresh_token)
        && member.auth_status !== 'revoked'
        && member.tesla_refresh_state !== 'uncertain'
        && member.tesla_refresh_state !== 'reconnect_required';
}

/** Reconcile one successful getProducts result. Tesla calls finish before membership writes. */
export class SiteMembershipService {
    constructor(
        private client: LoginClient,
        private importer: LoginImporter,
        private members = new SiteMembershipJoinRepo(),
        private sites = new SiteRepo(),
        private clientForUser = createTeslaClientForUser,
    ) {}

    async syncLogin(userId: string, products: FleetProduct[], fetchedAt: Date): Promise<string[]> {
        const listedIds = new Set(products.flatMap(product => product.energy_site_id ? [String(product.energy_site_id)] : []));
        const initial = await this.members.membersForUser(userId);
        const mapped = new Map(initial.map(member => [member.tesla_energy_site_id, member.site_id]));
        const siteIds = new Set<string>();

        for (const teslaId of listedIds) {
            const knownSiteId = mapped.get(teslaId);
            if (knownSiteId && await this.sites.touchMember(knownSiteId, userId, teslaId, fetchedAt)) {
                siteIds.add(knownSiteId);
                if (knownSiteId === teslaId && await this.sites.needsInitialImport(knownSiteId)) {
                    await this.importer.ensureSite(teslaId);
                }
                continue;
            }
            const info = await this.client.getEnergySiteInfo(teslaId);
            const hardwareId = typeof info.id === 'string' && info.id.trim() ? info.id : null;
            if (!hardwareId) logEvent('warn', 'site.member.hardware-missing', { teslaId });
            const result = await this.resolveProduct(userId, teslaId, info, hardwareId, fetchedAt);
            siteIds.add(result.siteId);
            if (result.kind === 'fresh') await this.importer.ensureSite(teslaId);
        }

        // A changed ID was already handled as a re-invite above. Each removal
        // still checks the old ID and timestamp, so a newer login wins.
        for (const member of await this.members.membersForUser(userId)) {
            if (!listedIds.has(member.tesla_energy_site_id)) {
                await this.sites.removeMemberIfMissing(member.site_id, userId,
                    member.tesla_energy_site_id, fetchedAt);
            }
        }
        for (const siteId of siteIds) await this.sites.repairConnection(siteId);
        await this.members.markChecked(userId, fetchedAt);
        return [...siteIds];
    }

    private async resolveProduct(userId: string, teslaId: string, info: EnergySiteInfo,
        hardwareId: string | null, fetchedAt: Date) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const observedMembers = hardwareId ? await this.members.membersForHardware(hardwareId) : [];
            let verifiedSiteId: string | null = null;
            let checked = 0;
            for (const member of observedMembers) {
                if (member.user_id === userId || !usable(member)) continue;
                if (checked >= 3) break;
                checked++;
                const client = await this.clientForUser(member.user_id);
                if (!client) throw new Error('Usable site member has no Tesla client');
                const products = await client.getProducts();
                if (products.some(product => String(product.energy_site_id) === member.tesla_energy_site_id)) {
                    verifiedSiteId = member.site_id;
                    break;
                }
            }
            const decision = await this.members.commitDecision({ userId, teslaId, info,
                hardwareId, observedMembers, verifiedSiteId, fetchedAt });
            if (decision.kind !== 'retry') return decision;
        }
        throw new Error('Site membership changed during login');
    }
}
