
import { NextResponse } from 'next/server';
import { AnnouncementRepo } from '@/lib/announcement-repo';
import { isUserAdmin } from '@/lib/auth-checks';
import { getCurrentUser } from '@/lib/auth-checks';

const repo = new AnnouncementRepo();

/**
 * GET: Fetch announcements (Public)
 * Query Params:
 *  - latest=true: Fetch only the latest announcement (for checking updates).
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const latest = searchParams.get('latest') === 'true';

    try {
        if (latest) {
            const announcement = await repo.getLatest();
            return NextResponse.json(announcement || {});
        } else {
            const announcements = await repo.getAll();
            return NextResponse.json(announcements);
        }
    } catch (error) {
        console.error('Failed to fetch announcements:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/**
 * POST: Create announcement (Admin only)
 */
import { sendDiscordAnnouncement, updateDiscordAnnouncement, deleteDiscordAnnouncement } from '@/lib/discord';

// ... existing imports

// ... existing GET ...

/**
 * POST: Create announcement (Admin only)
 */
export async function POST(request: Request) {
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await request.json();
        const { title, content } = body;

        if (!title || !content) {
            return NextResponse.json({ error: 'Title and content are required' }, { status: 400 });
        }

        // Get current user ID to set as author
        const user = await getCurrentUser();

        let announcement = await repo.create(title, content, user?.id);

        // Send Discord notification and update DB with the message ID
        try {
            const discordId = await sendDiscordAnnouncement(announcement);
            if (discordId) {
                const updated = await repo.update(announcement.id, announcement.title, announcement.content, discordId);
                if (updated) {
                    announcement = updated;
                }
            }
        } catch (err) {
            console.error('Failed to send/save Discord notification:', err);
        }

        return NextResponse.json(announcement, { status: 201 });
    } catch (error) {
        console.error('Failed to create announcement:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/**
 * PUT: Update announcement (Admin only)
 */
export async function PUT(request: Request) {
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const body = await request.json();
        const { id, title, content } = body;

        if (!id || !title || !content) {
            return NextResponse.json({ error: 'ID, title, and content are required' }, { status: 400 });
        }

        // Check for existing Discord message ID
        const existing = await repo.getById(id);
        if (existing?.discord_message_id) {
            // Update Discord message in background
            updateDiscordAnnouncement(existing.discord_message_id, { ...existing, title, content })
                .catch(err => console.error('Failed to update Discord message:', err));
        }

        const updated = await repo.update(id, title, content);
        if (!updated) {
            return NextResponse.json({ error: 'Announcement not found' }, { status: 404 });
        }

        return NextResponse.json(updated);
    } catch (error) {
        console.error('Failed to update announcement:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

/**
 * DELETE: Delete announcement (Admin only)
 */
export async function DELETE(request: Request) {
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'ID is required' }, { status: 400 });
        }

        const existing = await repo.getById(id);
        if (existing?.discord_message_id) {
            deleteDiscordAnnouncement(existing.discord_message_id)
                .catch(err => console.error('Failed to delete Discord message:', err));
        }

        await repo.delete(id);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to delete announcement:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
