import './bootstrap-env';
import { writeFileSync } from 'node:fs';
import { pool } from '../src/lib/db';
import { buildRatePlanAiHandoffMarkdown } from '../src/lib/tariff-ai-handoff';
import { TariffTimelineRepo } from '../src/lib/tariff-timeline-repo';

let poolInitialized = false;

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const siteName = argValue(args, '--site-name') ?? 'Harrison';
  const baseUrl = argValue(args, '--url');
  const cookie = argValue(args, '--cookie') ?? process.env.SITE_AUTH;
  const outPath = argValue(args, '--out');

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('Refusing: DATABASE_URL is required');
  }

  const query = pool.query;
  poolInitialized = true;

  const siteRes = await query<{ id: string; user_id: string | null }>(
    'SELECT id, user_id FROM "Site" WHERE name = $1 ORDER BY id ASC LIMIT 1',
    [siteName]
  );
  const site = siteRes.rows[0];
  if (!site) {
    throw new Error(`Site "${siteName}" not found.`);
  }

  let markdown: string;
  if (baseUrl) {
    if (!cookie) {
      throw new Error('Pass --cookie <site_auth> or set SITE_AUTH when using --url.');
    }
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/site/${encodeURIComponent(site.id)}/tariffs/ai-handoff`;
    const res = await fetch(endpoint, {
      headers: { Cookie: `site_auth=${cookie}` },
    });
    if (!res.ok) {
      throw new Error(`API request failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { markdown: string };
    markdown = data.markdown;
  } else {
    const timeline = await new TariffTimelineRepo().getTimeline(site.id, site.user_id);
    markdown = buildRatePlanAiHandoffMarkdown(timeline);
  }

  if (outPath) {
    writeFileSync(outPath, markdown, 'utf8');
    console.error(`Wrote ${markdown.length} bytes to ${outPath} (site ${site.id})`);
  } else {
    process.stdout.write(markdown);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!poolInitialized) return;
    try {
      await pool.end();
    } catch {
      process.exitCode = 1;
    }
  });
