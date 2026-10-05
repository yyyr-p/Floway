import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProviderBadge } from '../../../src/components/upstreams/provider-badge';
import { renderInApp } from '../../render';

describe('ProviderBadge custom logo', () => {
  it('uses the HTTPS logo and falls back to the provider mark when it fails', () => {
    const { container } = renderInApp(
      <ProviderBadge logoUrl="https://example.com/logo.svg" upstream={{ hue: 210, kind: 'custom' }} />,
    );
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.com/logo.svg');
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');

    fireEvent.error(image!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('keeps the type logo when the custom URL uses a rejected scheme', () => {
    const { container } = renderInApp(
      <ProviderBadge logoUrl="data:image/svg+xml,<svg/>" upstream={{ hue: 210, kind: 'custom' }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
