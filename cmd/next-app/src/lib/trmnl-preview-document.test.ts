import { describe, expect, it } from 'vitest';
import { buildTrmnlPreviewDocument } from './trmnl-preview-document';

describe('buildTrmnlPreviewDocument', () => {
    it('wraps markup in a self-contained 800x480 document', () => {
        const doc = buildTrmnlPreviewDocument('<div class="view">hello</div>');
        expect(doc.startsWith('<!doctype html>')).toBe(true);
        expect(doc).toContain('<div id="trmnl-root"><div class="view">hello</div></div>');
        expect(doc).toContain('width=800');
        expect(doc).toContain('.layout--col');
        expect(doc).not.toMatch(/<link|<script/);
    });
});
