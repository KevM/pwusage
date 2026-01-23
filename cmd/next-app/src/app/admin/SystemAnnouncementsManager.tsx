
'use client';

import { useState, useEffect, useRef } from 'react';
import type { SystemAnnouncement } from '@/lib/announcement-repo';
import ReactMarkdown from 'react-markdown';

export function SystemAnnouncementsManager() {
    const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [previewMode, setPreviewMode] = useState(false);

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
            ? JSON.stringify({ id: editingId, title, content })
            : JSON.stringify({ title, content });

        const res = await fetch('/api/announcements', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body,
        });

        if (res.ok) {
            setTitle('');
            setContent('');
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
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function handleCancel() {
        setEditingId(null);
        setTitle('');
        setContent('');
    }

    async function handleDelete(id: number) {
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
    const [uploading, setUploading] = useState(false);

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        if (!e.target.files || e.target.files.length === 0) {
            return;
        }

        const file = e.target.files[0];
        setUploading(true);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch(`/api/upload?filename=${file.name}`, {
                method: 'POST',
                body: file,
            });

            if (!res.ok) {
                throw new Error('Upload failed');
            }

            const blob = await res.json();
            const markdownImage = `\n![${file.name}](${blob.url})\n`;

            setContent(prev => prev + markdownImage);
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
        <div>
            <h2 className="text-xl font-semibold mb-4">System Announcements</h2>

            {/* Create/Edit Form */}
            <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 shadow rounded-lg p-4 mb-6">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-medium text-gray-900 dark:text-white">
                        {editingId ? 'Edit Announcement' : 'New Announcement'}
                    </h3>
                    {editingId && (
                        <button
                            type="button"
                            onClick={handleCancel}
                            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                        >
                            Cancel Edit
                        </button>
                    )}
                </div>
                <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Title</label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-700 dark:border-gray-600 text-gray-900 dark:text-white caret-indigo-500 p-2.5"
                        required
                    />
                </div>
                <div className="mb-4">
                    <div className="flex justify-between items-end mb-1">
                        <div className="flex space-x-1 bg-gray-100 dark:bg-gray-700 p-0.5 rounded-lg">
                            <button
                                type="button"
                                onClick={() => setPreviewMode(false)}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${!previewMode ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                            >
                                Write
                            </button>
                            <button
                                type="button"
                                onClick={() => setPreviewMode(true)}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${previewMode ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                            >
                                Preview
                            </button>
                        </div>

                        <div className="flex items-center">
                            <input
                                type="file"
                                ref={fileInputRef}
                                className="hidden"
                                accept="image/*"
                                onChange={handleUpload}
                            />
                            {!previewMode && (
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={uploading}
                                    className="text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 font-medium flex items-center ml-4"
                                >
                                    {uploading ? 'Uploading...' : 'Upload Image'}
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                    </svg>
                                </button>
                            )}
                        </div>
                    </div>

                    {previewMode ? (
                        <div className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 min-h-[9rem] prose prose-sm dark:prose-invert max-w-none">
                            {content ? <ReactMarkdown>{content}</ReactMarkdown> : <span className="text-gray-400 italic">Nothing to preview</span>}
                        </div>
                    ) : (
                        <textarea
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            rows={4}
                            className="w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 dark:bg-gray-700 dark:border-gray-600 text-gray-900 dark:text-white caret-indigo-500 p-2.5"
                            required
                        />
                    )}
                </div>
                <button
                    type="submit"
                    disabled={loading}
                    className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                    {loading ? (editingId ? 'Updating...' : 'Posting...') : (editingId ? 'Update Announcement' : 'Post Announcement')}
                </button>
            </form>

            {/* List */}
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
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
            </div>
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
    onDelete: (id: number) => void;
}) {
    return (
        <li className="p-4 hover:bg-gray-50 dark:hover:bg-gray-750">
            <div className="flex justify-between items-start">
                <div className="flex-1 mr-4">
                    <h3 className="text-sm font-bold text-gray-900 dark:text-white">{item.title}</h3>
                    <p className="text-xs text-gray-500 mt-1">
                        {new Date(item.created_at).toLocaleString()}
                    </p>
                    <div className="text-sm text-gray-600 dark:text-gray-300 mt-2 prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown>{item.content}</ReactMarkdown>
                    </div>
                </div>
                <div className="flex space-x-3 shrink-0">
                    <button
                        onClick={() => onEdit(item)}
                        className="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300 text-xs font-medium"
                    >
                        Edit
                    </button>
                    <button
                        onClick={() => onDelete(item.id)}
                        className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 text-xs font-medium"
                    >
                        Delete
                    </button>
                </div>
            </div>
        </li>
    );
}
