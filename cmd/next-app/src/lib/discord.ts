
import { SystemAnnouncement } from './announcement-repo';

const WEBHOOK_URL = process.env.DISCORD_ANNOUNCEMENTS_WEBHOOK_URL;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

function extractFirstImage(content: string): string | undefined {
    const match = content.match(/!\[.*?\]\((https?:\/\/.*?)\)/);
    return match ? match[1] : undefined;
}

function stripImages(content: string): string {
    return content.replace(/!\[.*?\]\(https?:\/\/.*?\)/g, '').trim();
}

export async function sendDiscordAnnouncement(announcement: SystemAnnouncement): Promise<string | undefined> {
    if (!WEBHOOK_URL) {
        console.warn('DISCORD_ANNOUNCEMENTS_WEBHOOK_URL is not set. Skipping Discord notification.');
        return;
    }

    const newsUrl = `${APP_URL}/news`;

    const imageUrl = extractFirstImage(announcement.content);
    const cleanContent = stripImages(announcement.content);

    const description = cleanContent.length > 500
        ? cleanContent.substring(0, 497) + '...'
        : cleanContent;

    const payload = {
        username: "Powerwall Usage Announcements",
        embeds: [{
            title: `📢 ${announcement.title}`,
            url: newsUrl,
            description: description,
            color: 0x5865F2, // Discord Blurple
            image: imageUrl ? { url: imageUrl } : undefined,
            footer: {
                text: "Powerwall Usage Admin"
            },
            timestamp: new Date().toISOString(),
            fields: [
                {
                    name: "Read more",
                    value: `[in the news feed](${newsUrl})`
                }
            ]
        }]
    };

    try {
        const url = new URL(WEBHOOK_URL);
        url.searchParams.append('wait', 'true');

        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`Failed to send Discord notification: ${response.status} ${response.statusText}`);
            return undefined;
        }

        const data = await response.json();
        return data.id;
    } catch (error) {
        console.error('Error sending Discord notification:', error);
        return undefined;
    }
}

export async function updateDiscordAnnouncement(messageId: string, announcement: SystemAnnouncement): Promise<void> {
    if (!WEBHOOK_URL) return;

    const newsUrl = `${APP_URL}/news`;
    const imageUrl = extractFirstImage(announcement.content);
    const cleanContent = stripImages(announcement.content);

    const description = cleanContent.length > 500
        ? cleanContent.substring(0, 497) + '...'
        : cleanContent;

    const payload = {
        embeds: [{
            title: `📢 ${announcement.title} (Edited)`,
            url: newsUrl,
            description: description,
            color: 0x5865F2,
            image: imageUrl ? { url: imageUrl } : undefined,
            footer: {
                text: "Powerwall Usage Admin"
            },
            timestamp: new Date().toISOString(),
            fields: [
                {
                    name: "Read more",
                    value: `[in the news feed](${newsUrl})`
                }
            ]
        }]
    };

    try {
        const response = await fetch(`${WEBHOOK_URL}/messages/${messageId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`Failed to update Discord notification: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error updating Discord notification:', error);
    }
}

export async function deleteDiscordAnnouncement(messageId: string): Promise<void> {
    if (!WEBHOOK_URL) return;

    try {
        const response = await fetch(`${WEBHOOK_URL}/messages/${messageId}`, {
            method: 'DELETE',
        });

        if (!response.ok) {
            console.error(`Failed to delete Discord notification: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error deleting Discord notification:', error);
    }
}
