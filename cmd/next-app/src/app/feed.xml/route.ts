
import { AnnouncementRepo } from '@/lib/announcement-repo';
import { marked } from 'marked';
import { getAppBaseUrl } from '@/lib/url-utils';

const repo = new AnnouncementRepo();

export async function GET() {
  const announcements = await repo.getAll(20);
  const baseUrl = getAppBaseUrl();
  const newsUrl = `${baseUrl}/news`;

  const items = await Promise.all(announcements.map(async (a) => {
    let htmlContent = await marked(a.content);
    // Replace relative links (href="/...") with absolute links
    htmlContent = htmlContent.replace(/href="\//g, `href="${baseUrl}/`);

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
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Powerwall Usage System Announcements</title>
    <link>${newsUrl}</link>
    <description>Latest updates and announcements from Powerwall Usage.</description>
    <language>en-us</language>
    <atom:link href="${baseUrl}/feed.xml" rel="self" type="application/rss+xml" />
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
