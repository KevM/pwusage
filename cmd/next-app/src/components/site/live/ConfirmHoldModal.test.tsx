import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmHoldModal } from './ConfirmHoldModal';
import { planReserve } from '@/lib/battery-hold-rules';

const noop = () => {};

describe('ConfirmHoldModal', () => {
  it('shows the 80-vs-100 reserve choice only when the plan is ambiguous', () => {
    const html = renderToStaticMarkup(
      <ConfirmHoldModal soc={90} plan={planReserve(90)} onConfirm={noop} onClose={noop} />,
    );
    expect(html).toContain('80%');
    expect(html).toContain('100%');
    expect(html).toMatch(/Reserve/i);
  });

  it('hides the reserve choice and states the target when unambiguous', () => {
    const html = renderToStaticMarkup(
      <ConfirmHoldModal soc={70} plan={planReserve(70)} onConfirm={noop} onClose={noop} />,
    );
    expect(html).not.toMatch(/Reserve/i);
    expect(html).toContain('70%');
  });

  it('offers auto-detect and fixed-duration options', () => {
    const html = renderToStaticMarkup(
      <ConfirmHoldModal soc={70} plan={planReserve(70)} onConfirm={noop} onClose={noop} />,
    );
    expect(html).toMatch(/Auto-detect/i);
    expect(html).toMatch(/Fixed/i);
  });
});
