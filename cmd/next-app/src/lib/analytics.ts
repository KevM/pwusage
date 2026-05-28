type Props = Record<string, string | number | boolean | undefined>;

export function track(event: string, props?: Props): void {
    if (typeof window === 'undefined') return;
    window.umami?.track(event, props);
}

export function identify(userId: string, traits?: Props): void {
    if (typeof window === 'undefined') return;
    window.umami?.identify(userId, traits);
}
