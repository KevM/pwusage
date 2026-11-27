'use client';

import { useCallback } from 'react';
import { drawQrWithLogo } from '@/lib/qr-generator';
import { continueUrl } from '@/app/continue/continue-logic';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

export function BatterySaverQuickLink({ siteId }: { siteId: string }) {
    const { toast } = useToast();
    // Callback ref to render QR code with centered logo as soon as canvas mounts
    const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
        if (canvas) {
            const deepLink = continueUrl(window.location.origin, `/site/${siteId}/live?action=park`);
            drawQrWithLogo(canvas, deepLink)
                .catch(err => console.error('Error generating Battery Saver QR code:', err));
        }
    }, [siteId]);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Battery Saver Quick Link (QR)</CardTitle>
                <CardDescription>
                    Saves your Powerwall charge for when rates spike. Scan this QR code with your phone to open the Live view and turn on Battery Saver.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center">
                <div className="bg-white p-3 rounded-lg border border-gray-100 dark:border-gray-800 shadow-sm mb-4">
                    <canvas ref={canvasRef} className="w-48 h-48" />
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm mb-4 italic">
                    Put this QR code near your EV charger so you can turn on Battery Saver from your phone before charging the car.
                </p>
                <div className="flex gap-4 w-full max-w-sm">
                    <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                            const deepLink = continueUrl(window.location.origin, `/site/${siteId}/live?action=park`);
                            navigator.clipboard.writeText(deepLink)
                                .then(() => toast({ title: 'Link copied', description: 'Battery Saver link copied to the clipboard.', variant: 'success' }))
                                .catch(() => toast({ title: 'Copy failed', description: 'Failed to copy link.', variant: 'danger' }));
                        }}
                    >
                        Copy Link
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
