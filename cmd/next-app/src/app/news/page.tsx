
import ReactMarkdown from 'react-markdown';
import { AnnouncementRepo } from '@/lib/announcement-repo';
import { Metadata } from 'next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { PageBreadcrumbs } from '@/components/PageBreadcrumbs';
import { getDefaultSiteId } from '@/lib/auth-checks';
import { SiteRepo } from '@/lib/site-repo';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';

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
    const defaultSiteId = await getDefaultSiteId();
    const energyRepo = new SiteRepo();
    const defaultSite = defaultSiteId ? await energyRepo.getSite(defaultSiteId) : null;

    const firstBreadcrumb = defaultSite
        ? { label: defaultSite.name, href: `/site/${defaultSite.id}` }
        : {
            label: (
                <span className="inline-flex items-center" aria-label="Home">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955a1.125 1.125 0 0 1 1.591 0L21.75 12M4.5 9.75V19.5A2.25 2.25 0 0 0 6.75 21.75h10.5A2.25 2.25 0 0 0 19.5 19.5V9.75M8.25 21.75v-6a1.5 1.5 0 0 1 1.5-1.5h4.5a1.5 1.5 0 0 1 1.5 1.5v6" />
                    </svg>
                </span>
            ),
            href: '/'
        };

    return (
        <div className="bg-bg-muted/30">
            <PageShell maxWidth="lg" padding="relaxed">
                <PageBreadcrumbs items={[
                    firstBreadcrumb,
                    { label: 'News' }
                ]} />
                <PageHeader
                    title="News & Changelog"
                    description="New updates and product improvements"
                    className="mb-12 mt-4"
                />

                <div className="space-y-12">
                    {announcements.length > 0 ? (
                        announcements.map((post) => (
                            <article key={post.id}>
                                <Card className="overflow-hidden">
                                    <CardHeader>
                                        <CardDescription className="mb-2">
                                            <span className="inline-flex items-center gap-2">
                                                <svg className="h-4 w-4 text-secondary/80" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                                                    <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
                                                </svg>
                                                <span>
                                            {new Date(post.created_at).toLocaleDateString(undefined, {
                                                year: 'numeric',
                                                month: 'long',
                                                day: 'numeric'
                                            })}
                                                </span>
                                                {post.updated_at && new Date(post.updated_at).getTime() > new Date(post.created_at).getTime() + 1000 && (
                                                    <Badge variant="info">
                                                        Edited {new Date(post.updated_at).toLocaleDateString(undefined, {
                                                        year: 'numeric',
                                                        month: 'long',
                                                        day: 'numeric'
                                                        })}
                                                    </Badge>
                                                )}
                                            </span>
                                        </CardDescription>
                                        <CardTitle className="text-2xl">{post.title}</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="prose dark:prose-invert max-w-none text-gray-600 dark:text-gray-300">
                                        <ReactMarkdown>{post.content}</ReactMarkdown>
                                        </div>
                                    </CardContent>
                                </Card>
                            </article>
                        ))
                    ) : (
                        <Card>
                            <CardContent className="pt-6">
                                <EmptyState
                                    title="No announcements yet"
                                    description="Check back later for updates."
                                    icon={
                                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                        </svg>
                                    }
                                />
                            </CardContent>
                        </Card>
                    )}
                </div>
            </PageShell>
        </div>
    );
}
