import { redirect } from 'next/navigation';

export default async function SiteSettingsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    redirect(`/site/${id}?view=settings`);
}
