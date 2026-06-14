'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Label, Input } from '@/components/ui/Form';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { SiteRoiConfig } from '@/lib/db';

export function RoiConfigForm({ siteId, initial }: { siteId: string; initial: SiteRoiConfig | null }) {
    const router = useRouter();
    const { toast } = useToast();
    const [form, setForm] = useState({
        solar_cost: initial?.solar_cost ?? '', solar_install_date: initial?.solar_install_date ?? '',
        battery_cost: initial?.battery_cost ?? '', battery_install_date: initial?.battery_install_date ?? '',
    });
    const [saving, setSaving] = useState(false);
    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

    async function save() {
        setSaving(true);
        try {
            const res = await fetch(`/api/site/${siteId}/roi-config`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
            });
            if (!res.ok) throw new Error('save failed');
            toast({ title: 'Saved', description: 'ROI settings updated.', variant: 'success' });
            router.refresh();
        } catch {
            toast({ title: 'Error', description: 'Could not save ROI settings.', variant: 'danger' });
        } finally { setSaving(false); }
    }

    const field = (label: string, k: keyof typeof form, type = 'number', step?: string) => (
        <div className="flex flex-col gap-1">
            <Label>{label}</Label>
            <Input type={type} step={step} value={String(form[k])} onChange={set(k)} />
        </div>
    );

    return (
        <Card>
            <CardHeader>
                <CardTitle>ROI / Savings</CardTitle>
                <CardDescription>System costs for ROI calculations.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {field('Solar net cost ($)', 'solar_cost')}
                {field('Solar install date', 'solar_install_date', 'date')}
                {field('Battery net cost ($)', 'battery_cost')}
                {field('Battery install date', 'battery_install_date', 'date')}
                <div className="sm:col-span-2 mt-2">
                    <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save ROI settings'}</Button>
                </div>
            </CardContent>
        </Card>
    );
}
