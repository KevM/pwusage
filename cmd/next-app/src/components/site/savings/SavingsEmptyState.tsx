import { Card, CardContent } from '@/components/ui/Card';

export function SavingsEmptyState() {
    return (
        <Card>
            <CardContent className="py-12 text-center text-foreground">
                <p className="text-lg font-semibold mb-2">Add your system costs to see payback</p>
                <p className="opacity-70">Set solar/battery costs and a flat comparison rate in the Settings tab →</p>
            </CardContent>
        </Card>
    );
}
