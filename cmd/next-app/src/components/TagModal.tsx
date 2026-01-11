import React, { useState } from 'react';

interface TagModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (tag: string) => void;
    currentTags?: string[];
    availableTags: string[];
}

export default function TagModal({ isOpen, onClose, onSave, currentTags = [], availableTags }: TagModalProps) {
    const [customTag, setCustomTag] = useState('');

    if (!isOpen) return null;

    const handleSave = (tag: string) => {
        onSave(tag);
        setCustomTag('');
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-6 w-full max-w-md">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-white">Tag Load Event</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl">&times;</button>
                </div>

                <div className="mb-4">
                    <p className="text-sm text-gray-400 mb-2">Select a common tag:</p>
                    <div className="flex flex-wrap gap-2">
                        {availableTags.map(tag => (
                            <button
                                key={tag}
                                onClick={() => handleSave(tag)}
                                disabled={currentTags.includes(tag)}
                                className={`px-3 py-1 rounded-full text-sm border transition-colors
                                    ${currentTags.includes(tag)
                                        ? 'bg-blue-600 border-blue-500 text-white font-bold cursor-not-allowed shadow-md'
                                        : 'bg-gray-700 border-gray-600 text-white hover:bg-gray-600 hover:border-gray-400'
                                    }`}
                            >
                                {tag}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="mb-6">
                    <p className="text-sm text-gray-400 mb-2">Or enter a custom tag:</p>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={customTag}
                            onChange={(e) => setCustomTag(e.target.value)}
                            className="flex-1 bg-gray-800 border border-gray-700 text-white px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="e.g., Workshop"
                        />
                        <button
                            onClick={() => { if (customTag) handleSave(customTag); }}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium"
                        >
                            Add
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
