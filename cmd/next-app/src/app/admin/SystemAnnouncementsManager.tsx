
'use client';

import { useState, useEffect, useRef } from 'react';
import type { SystemAnnouncement } from '@/lib/announcement-repo';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/Button';
import { Input, Label, Textarea } from '@/components/ui/Form';
import { SectionCard } from '@/components/ui/SectionCard';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';

export function SystemAnnouncementsManager() {
    const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [previewMode, setPreviewMode] = useState(false);
    const [createdAt, setCreatedAt] = useState<string>('');

    useEffect(() => {
        async function fetchAnnouncements() {
            const res = await fetch('/api/announcements');
            if (res.ok) {
                const data = await res.json();
                setAnnouncements(data);
            }
        }
        fetchAnnouncements();
    }, [refreshKey]);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setLoading(true);

        const method = editingId ? 'PUT' : 'POST';
        const body = editingId
            ? JSON.stringify({ id: editingId, title, content, createdAt: createdAt || undefined })
            : JSON.stringify({ title, content, createdAt: createdAt || undefined });

        const res = await fetch('/api/announcements', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body,
        });

        if (res.ok) {
            setTitle('');
            setContent('');
            setCreatedAt('');
            setEditingId(null);
            setRefreshKey(prev => prev + 1);
        } else {
            alert(`Failed to ${editingId ? 'update' : 'post'} announcement`);
        }
        setLoading(false);
    }

    function handleEdit(item: SystemAnnouncement) {
        setEditingId(item.id);
        setTitle(item.title);
        setContent(item.content);
        // Format date for datetime-local input: YYYY-MM-DDTHH:mm
        const date = new Date(item.created_at);
        const formattedDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        setCreatedAt(formattedDate);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function handleCancel() {
        setEditingId(null);
        setTitle('');
        setContent('');
        setCreatedAt('');
    }

    async function handleDelete(id: string) {
        if (!confirm('Are you sure you want to delete this announcement?')) return;

        const res = await fetch(`/api/announcements?id=${id}`, { method: 'DELETE' });
        if (res.ok) {
            setRefreshKey(prev => prev + 1);
            if (editingId === id) handleCancel();
        } else {
            alert('Failed to delete announcement');
        }
    }

    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [uploading, setUploading] = useState(false);

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        if (!e.target.files || e.target.files.length === 0) {
            return;
        }

        const file = e.target.files[0];
        setUploading(true);

        try {
            const res = await fetch(`/api/upload?filename=${file.name}`, {
                method: 'POST',
                body: file,
            });

            if (!res.ok) {
                throw new Error('Upload failed');
            }

            const blob = await res.json();
            const markdownImage = `\n![${file.name}](${blob.url})\n`;

            if (textareaRef.current) {
                const start = textareaRef.current.selectionStart;
                const end = textareaRef.current.selectionEnd;
                const text = content;
                const before = text.substring(0, start);
                const after = text.substring(end);

                // Ensure there's a newline before and after if needed
                const prefix = before.endsWith('\n') || before === '' ? '' : '\n';
                const suffix = after.startsWith('\n') || after === '' ? '' : '\n';
                const finalMarkdown = `${prefix}![${file.name}](${blob.url})${suffix}`;

                const newContent = before + finalMarkdown + after;
                setContent(newContent);

                // Move cursor after insertion in next render
                setTimeout(() => {
                    if (textareaRef.current) {
                        const newCursorPos = start + finalMarkdown.length;
                        textareaRef.current.focus();
                        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
                    }
                }, 0);
            } else {
                setContent(prev => prev + markdownImage);
            }
        } catch (error) {
            console.error('Upload error:', error);
            alert('Failed to upload image');
        } finally {
            setUploading(false);
            if (fileInputRef.current) {
                fileInputRef.current.value = '';
            }
        }
    }

    return (
        <div className="space-y-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">System Announcements</h2>

            {/* Create/Edit Form */}
            <SectionCard
                title={editingId ? 'Edit Announcement' : 'New Announcement'}
                action={editingId ? (
                    <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
                        Cancel Edit
                    </Button>
                ) : null}
            >
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-1.5">
                        <Label htmlFor="announcement-title">Title</Label>
                        <Input
                            id="announcement-title"
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="announcement-created-at">Posted Date (Optional)</Label>
                        <Input
                            id="announcement-created-at"
                            type="datetime-local"
                            value={createdAt}
                            onChange={(e) => setCreatedAt(e.target.value)}
                        />
                        <p className="text-xs text-gray-500">
                            Leave blank to use current time (or keep existing date when editing).
                        </p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <Tabs
                                value={previewMode ? 'preview' : 'write'}
                                onValueChange={(value) => setPreviewMode(value === 'preview')}
                            >
                                <TabsList className="p-1">
                                    <TabsTrigger value="write" className="px-3 py-1 text-xs">Write</TabsTrigger>
                                    <TabsTrigger value="preview" className="px-3 py-1 text-xs">Preview</TabsTrigger>
                                </TabsList>
                            </Tabs>

                            <div className="flex items-center">
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    className="hidden"
                                    accept="image/*"
                                    onChange={handleUpload}
                                />
                                {!previewMode && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={uploading}
                                        appearance="icon"
                                        iconPosition="right"
                                        icon={(
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                            </svg>
                                        )}
                                    >
                                        {uploading ? 'Uploading...' : 'Upload Image'}
                                    </Button>
                                )}
                            </div>
                        </div>

                        {previewMode ? (
                            <div className="min-h-[9rem] rounded-md border border-gray-200 bg-gray-50 p-4 prose prose-sm max-w-none dark:border-slate-700 dark:bg-slate-900 dark:prose-invert">
                                {content ? <ReactMarkdown>{content}</ReactMarkdown> : <span className="text-gray-400 italic">Nothing to preview</span>}
                            </div>
                        ) : (
                            <Textarea
                                ref={textareaRef}
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                rows={4}
                                required
                            />
                        )}
                    </div>

                    <Button type="submit" disabled={loading}>
                        {loading ? (editingId ? 'Updating...' : 'Posting...') : (editingId ? 'Update Announcement' : 'Post Announcement')}
                    </Button>
                </form>
            </SectionCard>

            {/* List */}
            <SectionCard title="Published Announcements" bodyClassName="p-0">
                <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                    {announcements.map((item) => (
                        <AnnouncementListItem
                            key={item.id}
                            item={item}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                        />
                    ))}
                    {announcements.length === 0 && (
                        <li className="p-4 text-center text-gray-500 text-sm italic">
                            No announcements found.
                        </li>
                    )}
                </ul>
            </SectionCard>
        </div>
    );
}

function AnnouncementListItem({
    item,
    onEdit,
    onDelete
}: {
    item: SystemAnnouncement;
    onEdit: (item: SystemAnnouncement) => void;
    onDelete: (id: string) => void;
}) {
    return (
        <li className="p-4 hover:bg-gray-50 dark:hover:bg-slate-800/50">
            <div className="flex justify-between items-start">
                <div className="flex-1 mr-4">
                    <h3 className="text-sm font-bold text-gray-900 dark:text-white">{item.title}</h3>
                    <p className="text-xs text-gray-500 mt-1">
                        Posted on {new Date(item.created_at).toLocaleString()}
                        {item.updated_at && new Date(item.updated_at).getTime() > new Date(item.created_at).getTime() + 1000 && (
                            <> • Edited on {new Date(item.updated_at).toLocaleString()}</>
                        )}
                    </p>
                    <div className="text-sm text-gray-600 dark:text-gray-300 mt-2 prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown>{item.content}</ReactMarkdown>
                    </div>
                </div>
                <div className="flex space-x-3 shrink-0">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onEdit(item)}
                    >
                        Edit
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onDelete(item.id)}
                        className="border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/30"
                    >
                        Delete
                    </Button>
                </div>
            </div>
        </li>
    );
}
