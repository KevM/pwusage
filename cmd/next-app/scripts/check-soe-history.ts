import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env before importing app modules that depend on DATABASE_URL, tokens, etc.
loadEnvConfig(path.resolve(__dirname, '../'));

interface CliArgs {
    siteId?: string;
    hours: number;
    period: string;
    startIso?: string;
    endIso?: string;
    csv: boolean;
}

interface SoeSample {
    timestamp?: string;
    percentage_charged?: number;
}

interface RawSoeCalendarHistory {
    response?: {
        time_series?: SoeSample[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        hours: 24,
        period: 'day',
        csv: false
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--site' || token === '--site-id') {
            args.siteId = argv[i + 1];
            i++;
        } else if (token === '--hours') {
            const parsed = Number(argv[i + 1]);
            if (!Number.isNaN(parsed) && parsed > 0) {
                args.hours = parsed;
            }
            i++;
        } else if (token === '--period') {
            args.period = argv[i + 1] || 'day';
            i++;
        } else if (token === '--start') {
            args.startIso = argv[i + 1];
            i++;
        } else if (token === '--end') {
            args.endIso = argv[i + 1];
            i++;
        } else if (token === '--csv') {
            args.csv = true;
        }
    }

    return args;
}

function summarize(rows: SoeSample[]): void {
    const values = rows
        .map(r => r.percentage_charged)
        .filter((v): v is number => typeof v === 'number');

    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    const firstTs = rows[0]?.timestamp ?? null;
    const lastTs = rows[rows.length - 1]?.timestamp ?? null;

    console.log('\nSummary');
    console.log(`- samples: ${rows.length}`);
    console.log(`- first timestamp: ${firstTs}`);
    console.log(`- last timestamp: ${lastTs}`);
    console.log(`- min SoC: ${min}`);
    console.log(`- max SoC: ${max}`);
}

async function run(): Promise<void> {
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { createTeslaClientForSite } = await import('../src/lib/tesla-client-factory');

    const args = parseArgs(process.argv.slice(2));
    const siteRepo = new SiteRepo();

    let siteId = args.siteId;
    if (!siteId) {
        const siteIds = await siteRepo.getSiteIds();
        siteId = siteIds[0];
        if (!siteId) {
            throw new Error('No sites found in DB. Provide --site <siteId>.');
        }
        console.log(`No --site provided. Using first site: ${siteId}`);
    }

    const site = await siteRepo.getSite(siteId);
    if (!site) {
        throw new Error(`Site not found: ${siteId}`);
    }
    const client = await createTeslaClientForSite(siteId);
    if (!client) {
        throw new Error(`Site ${siteId} is missing Tesla tokens (access/refresh).`);
    }

    const end = args.endIso ? new Date(args.endIso) : new Date();
    const start = args.startIso ? new Date(args.startIso) : new Date(end.getTime() - args.hours * 60 * 60 * 1000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error('Invalid --start or --end. Use ISO format, e.g. 2026-02-15T06:00:00Z');
    }
    const tz = site.timezone || 'UTC';

    console.log(`\nSOE probe`);
    console.log(`- site: ${siteId}`);
    console.log(`- timezone: ${tz}`);
    console.log(`- period: ${args.period}`);
    console.log(`- start: ${start.toISOString()}`);
    console.log(`- end: ${end.toISOString()}`);

    const rawFetcher = client as unknown as {
        fetch<T>(path: string, options?: RequestInit): Promise<T>;
    };

    const s = start.toISOString();
    const e = end.toISOString();
    console.log(`- iso range (utc): ${s} to ${e}`);

    const parsedRows = await client.getSoeHistory(siteId, start, end, args.period, tz);
    summarize(parsedRows);
    console.log('\nFirst 5 parsed samples:');
    console.log(JSON.stringify(parsedRows.slice(0, 5), null, 2));
    if (args.csv) {
        console.log('\nCSV');
        console.log('timestamp,percentage_charged');
        for (const row of parsedRows) {
            console.log(`${row.timestamp},${row.percentage_charged}`);
        }
    }

    // Also inspect raw Tesla payload shape using the same internal client auth/refresh flow.
    const query = new URLSearchParams({
        kind: 'soe',
        start_date: formatDateWithTimezone(start, tz),
        end_date: formatDateWithTimezone(end, tz),
        period: args.period,
        time_zone: tz
    });
    const raw = await rawFetcher.fetch<RawSoeCalendarHistory>(`/api/1/energy_sites/${siteId}/calendar_history?${query.toString()}`);

    const responseKeys = raw.response ? Object.keys(raw.response) : [];
    console.log('\nRaw response keys:');
    console.log(responseKeys);
    console.log('\nRaw response sample:');
    console.log(JSON.stringify(raw.response, null, 2).slice(0, 1500));
}

function formatDateWithTimezone(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'shortOffset'
    }).formatToParts(date);

    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');
    const tzName = get('timeZoneName');

    let offsetMinutes = 0;
    const match = tzName.match(/GMT([+-]?)(\d{1,2})(?::?(\d{2}))?/i);
    if (match) {
        const sign = match[1] === '-' ? -1 : 1;
        const hrs = Number(match[2]);
        const mins = match[3] ? Number(match[3]) : 0;
        offsetMinutes = sign * (hrs * 60 + mins);
    } else {
        const localMs = date.getTime();
        const loc = new Date(date.toLocaleString('en-US', { timeZone })).getTime();
        offsetMinutes = Math.round((loc - localMs) / (60 * 1000));
    }

    const offH = Math.floor(Math.abs(offsetMinutes) / 60).toString().padStart(2, '0');
    const offM = Math.abs(offsetMinutes % 60).toString().padStart(2, '0');
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const offset = `${sign}${offH}:${offM}`;

    return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('SOE probe failed:', error);
        process.exit(1);
    });
