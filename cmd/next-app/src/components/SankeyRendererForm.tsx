'use client';

import { useState } from 'react';
import { updateSankeyRenderer } from '@/app/site/[id]/settings/actions';
import { Label, Select } from '@/components/ui/Form';

interface SankeyRendererFormProps {
    siteId: string;
    initialRenderer: string;
    options: { id: string; label: string }[];
}

export function SankeyRendererForm({ siteId, initialRenderer, options }: SankeyRendererFormProps) {
    const [current, setCurrent] = useState(initialRenderer);
    const [isPending, setIsPending] = useState(false);

    const handleChange = async (rendererId: string) => {
        setIsPending(true);
        const formData = new FormData();
        formData.append('siteId', siteId);
        formData.append('rendererId', rendererId);
        try {
            await updateSankeyRenderer(formData);
            setCurrent(rendererId);
        } catch (error) {
            console.error('Failed to update Sankey renderer:', error);
            alert('Failed to update settings. Please try again.');
        } finally {
            setIsPending(false);
        }
    };

    return (
        <form className="space-y-2">
            <Label className="block">Energy Flow Diagram Style</Label>
            <Select
                value={current}
                onChange={(e) => handleChange(e.target.value)}
                disabled={isPending || options.length <= 1}
            >
                {options.map(o => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                ))}
            </Select>
            <p className="text-xs text-gray-500">
                Controls the Sankey value-flow diagram on the Live page.
            </p>
        </form>
    );
}
