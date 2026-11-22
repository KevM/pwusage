import { describe, expect, it } from 'vitest';
import { buildTrmnlPreviewDocument, TRMNL_FRAMEWORK_VERSION } from './trmnl-preview-document';

describe('buildTrmnlPreviewDocument', () => {
    const doc = buildTrmnlPreviewDocument('<div class="view view--full">hello</div>');

    it('is an 800x480 document', () => {
        expect(doc.startsWith('<!doctype html>')).toBe(true);
        expect(doc).toContain('width=800');
    });

    it('renders with the pinned TRMNL framework stylesheet, not a hand-written copy', () => {
        expect(TRMNL_FRAMEWORK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        expect(doc).toContain(
            `<link rel="stylesheet" href="https://trmnl.com/css/${TRMNL_FRAMEWORK_VERSION}/plugins.css" />`
        );
        expect(doc).not.toContain('.layout--col');
    });

    it('resolves the framework font URLs against trmnl.com', () => {
        // plugins.css references /fonts/*.ttf; the web iframe (srcdoc) and the iOS
        // web view (loadHTMLString with no base URL) both need an absolute base.
        expect(doc).toContain('<base href="https://trmnl.com/" />');
    });

    it('wraps markup in the same body and screen elements TRMNL renders with', () => {
        expect(doc).toContain(
            '<body class="environment trmnl"><div class="screen"><div class="view view--full">hello</div></div></body>'
        );
    });

    it('loads no scripts, so it behaves the same in the sandboxed iframe and the iOS web view', () => {
        expect(doc).not.toMatch(/<script/);
    });
});
