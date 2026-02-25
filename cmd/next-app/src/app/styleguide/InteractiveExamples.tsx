'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { Switch } from '@/components/ui/Switch';
import { ToastProvider, useToast } from '@/components/ui/Toast';
import { Label } from '@/components/ui/Form';

function ToastButtons() {
    const { toast } = useToast();

    return (
        <div className="flex flex-wrap gap-3">
            <Button
                size="sm"
                onClick={() => toast({ title: 'Saved', description: 'Your settings were updated.', variant: 'success' })}
            >
                Success Toast
            </Button>
            <Button
                size="sm"
                variant="secondary"
                onClick={() => toast({ title: 'Heads up', description: 'The data may be stale.', variant: 'warning' })}
            >
                Warning Toast
            </Button>
            <Button
                size="sm"
                variant="outline"
                onClick={() => toast({ title: 'Request failed', description: 'Could not reach Tesla API.', variant: 'danger' })}
            >
                Error Toast
            </Button>
        </div>
    );
}

export function InteractiveExamples() {
    const [tab, setTab] = useState('bill');
    const [enabled, setEnabled] = useState(true);

    return (
        <div className="space-y-10">
            <div className="space-y-3">
                <span className="text-xs text-secondary font-mono block">Tabs</span>
                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList>
                        <TabsTrigger value="history">History</TabsTrigger>
                        <TabsTrigger value="bill">Estimated Bill</TabsTrigger>
                        <TabsTrigger value="settings">Settings</TabsTrigger>
                    </TabsList>

                    <TabsContent value="history" className="mt-4 rounded-md border border-gray-200 p-4 text-sm dark:border-slate-800">
                        History content panel
                    </TabsContent>
                    <TabsContent value="bill" className="mt-4 rounded-md border border-gray-200 p-4 text-sm dark:border-slate-800">
                        Estimated Bill content panel
                    </TabsContent>
                    <TabsContent value="settings" className="mt-4 rounded-md border border-gray-200 p-4 text-sm dark:border-slate-800">
                        Settings content panel
                    </TabsContent>
                </Tabs>
            </div>

            <div className="space-y-3">
                <span className="text-xs text-secondary font-mono block">Switch</span>
                <div className="flex items-center gap-3">
                    <Switch checked={enabled} onCheckedChange={setEnabled} />
                    <Label className="font-normal">Enable live refresh: {enabled ? 'On' : 'Off'}</Label>
                </div>
            </div>

            <div className="space-y-3">
                <span className="text-xs text-secondary font-mono block">Toast</span>
                <ToastProvider>
                    <ToastButtons />
                </ToastProvider>
            </div>
        </div>
    );
}
