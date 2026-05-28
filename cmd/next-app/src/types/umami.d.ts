export {};

declare global {
    interface Window {
        umami?: {
            track: (event: string, props?: Record<string, unknown>) => void;
            identify: (userId: string, traits?: Record<string, unknown>) => void;
        };
    }
}
