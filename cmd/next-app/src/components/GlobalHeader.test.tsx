import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useParams: () => ({}), usePathname: () => '/' }));
vi.mock('./HeaderLiveStats', () => ({ HeaderLiveStats: () => null }));
vi.mock('./NewsNotificationIcon', () => ({ NewsNotificationIcon: () => null }));

import { GlobalHeader } from './GlobalHeader';

describe('GlobalHeader', () => {
    it('is site chrome, so an embedding app can hide it', () => {
        expect(renderToStaticMarkup(<GlobalHeader />)).toContain('<header data-site-chrome="true"');
    });
});
