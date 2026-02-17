
import ReactMarkdown from 'react-markdown';
import { AnnouncementRepo } from '@/lib/announcement-repo';
import { Metadata } from 'next';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const DEFAULT_NEWS_DESCRIPTION = 'Latest updates and announcements from the developers.';
const NEWS_TITLE = 'News & Announcements | Powerwall Usage';
const DEFAULT_OG_IMAGE = '/opengraph-image';

function getFirstParagraph(markdown: string): string {
    const paragraphs = markdown
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    if (paragraphs.length === 0) {
        return '';
    }

    return paragraphs[0]
        .replace(/!\[[^\]]*]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/[*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getDescription(content?: string): string {
    if (!content) {
        return DEFAULT_NEWS_DESCRIPTION;
    }

    const firstParagraph = getFirstParagraph(content);
    if (!firstParagraph) {
        return DEFAULT_NEWS_DESCRIPTION;
    }

    return firstParagraph.slice(0, 200);
}

function getFirstImageUrl(markdown?: string): string | undefined {
    if (!markdown) {
        return undefined;
    }

    const match = markdown.match(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
    if (!match?.[1]) {
        return undefined;
    }

    const candidate = match[1].trim();
    if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('/')) {
        return candidate;
    }

    return undefined;
}

export async function generateMetadata(): Promise<Metadata> {
    try {
        const latestAnnouncement = await new AnnouncementRepo().getLatest();
        const description = getDescription(latestAnnouncement?.content);
        const latestPostImage = getFirstImageUrl(latestAnnouncement?.content);
        const ogImages = latestPostImage ? [latestPostImage, DEFAULT_OG_IMAGE] : [DEFAULT_OG_IMAGE];

        return {
            title: NEWS_TITLE,
            description,
            openGraph: {
                title: NEWS_TITLE,
                description,
                images: ogImages,
            },
            twitter: {
                card: 'summary_large_image',
                title: NEWS_TITLE,
                description,
                images: ogImages,
            },
        };
    } catch {
        return {
            title: NEWS_TITLE,
            description: DEFAULT_NEWS_DESCRIPTION,
            openGraph: {
                title: NEWS_TITLE,
                description: DEFAULT_NEWS_DESCRIPTION,
                images: [DEFAULT_OG_IMAGE],
            },
            twitter: {
                card: 'summary_large_image',
                title: NEWS_TITLE,
                description: DEFAULT_NEWS_DESCRIPTION,
                images: [DEFAULT_OG_IMAGE],
            },
        };
    }
}

export default async function NewsPage() {
    const repo = new AnnouncementRepo();
    const announcements = await repo.getAll(20);

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-slate-900 py-12 px-4 sm:px-6 lg:px-8">
            <div className="max-w-4xl mx-auto">
                <div className="text-center mb-12">
                    <Link href="/" className="inline-block mb-4 text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300 font-medium">
                        &larr; Back to Dashboard
                    </Link>
                    <h1 className="text-4xl font-extrabold text-gray-900 dark:text-white sm:text-5xl sm:tracking-tight lg:text-6xl">
                        Changelog
                    </h1>
                    <p className="mt-5 max-w-xl mx-auto text-xl text-gray-500 dark:text-gray-400">
                        New updates and product improvements
                    </p>
                </div>

                <div className="space-y-12">
                    {announcements.length > 0 ? (
                        announcements.map((post) => (
                            <article key={post.id} className="bg-white dark:bg-gray-800 shadow-lg rounded-2xl overflow-hidden">
                                <div className="p-8">
                                    <div className="flex items-center text-sm text-gray-500 dark:text-gray-400 mb-4">
                                        <span className="flex items-center">
                                            <svg className="flex-shrink-0 mr-1.5 h-5 w-5 text-gray-400 dark:text-gray-500" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                                                <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
                                            </svg>
                                            {new Date(post.created_at).toLocaleDateString(undefined, {
                                                year: 'numeric',
                                                month: 'long',
                                                day: 'numeric'
                                            })}
                                            {post.updated_at && new Date(post.updated_at).getTime() > new Date(post.created_at).getTime() + 1000 && (
                                                <span className="ml-2 text-xs opacity-75">
                                                    (Edited {new Date(post.updated_at).toLocaleDateString(undefined, {
                                                        year: 'numeric',
                                                        month: 'long',
                                                        day: 'numeric'
                                                    })})
                                                </span>
                                            )}
                                        </span>
                                    </div>
                                    <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                                        {post.title}
                                    </h2>
                                    <div className="prose dark:prose-invert max-w-none text-gray-600 dark:text-gray-300">
                                        <ReactMarkdown>{post.content}</ReactMarkdown>
                                    </div>
                                </div>
                            </article>
                        ))
                    ) : (
                        <div className="text-center py-12 bg-white dark:bg-gray-800 shadow rounded-lg">
                            <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No announcements yet</h3>
                            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Check back later for updates.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
