export function formatTouName(name: string): string {
    if (!name) return '';
    // Only format if it looks like an enum constant (ALL_CAPS_WITH_UNDERSCORES)
    if (/^[A-Z_]+$/.test(name)) {
        return name
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('-');
    }
    return name;
}
