
import { AnnouncementRepo } from '@/lib/announcement-repo';
import { marked } from 'marked';

const repo = new AnnouncementRepo();

export async function GET() {
  const announcements = await repo.getAll(20);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    ? process.env.NEXT_PUBLIC_APP_URL
    : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  const newsUrl = `${baseUrl}/news`;

  const items = await Promise.all(announcements.map(async (a) => {
    const htmlContent = await marked(a.content);
    return `
    <item>
      <title><![CDATA[${a.title}]]></title>
      <description><![CDATA[${htmlContent}]]></description>
      <link>${newsUrl}</link>
      <guid isPermaLink="false">${a.id}</guid>
      <pubDate>${new Date(a.created_at).toUTCString()}</pubDate>
    </item>`;
  }));

  const rss = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>Powerwall Usage System Announcements</title>
    <link>${newsUrl}</link>
    <description>Latest updates and announcements from Powerwall Usage.</description>
    <language>en-us</language>
    ${items.join('')}
  </channel>
</rss>`;

  return new Response(rss, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate',
    },
  });
}
