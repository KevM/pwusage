/** OAuth request bodies are small forms and JSON; anything larger is refused unread. */
export const OAUTH_MAX_BODY_BYTES = 16_384;

/**
 * The request body as text, or null when it exceeds maxBytes. Stops reading at
 * the limit, so an oversized body never lands in memory or the database.
 */
export async function readBoundedRequestText(request: Request, maxBytes = OAUTH_MAX_BODY_BYTES): Promise<string | null> {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;
    if (!request.body) return '';
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}
