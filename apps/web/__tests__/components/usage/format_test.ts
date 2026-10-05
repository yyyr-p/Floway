import { describe, expect, it } from 'vitest';

import { formatCompactDecimalCount, formatMetricValue } from '../../../src/components/usage/format';
import { metricConfig } from '../../../src/components/usage/metrics';
import type { UsageMetric } from '../../../src/components/usage/types';

const tokenMetrics = Object.entries(metricConfig)
  .filter(([, config]) => config.kind === 'tokens')
  .map(([metric]) => metric as UsageMetric);

describe('usage token formatting', () => {
  for (const locale of ['en', 'zh-Hans']) {
    it(`uses K/M units for every token metric in ${locale}`, () => {
      for (const metric of tokenMetrics) {
        expect(formatMetricValue(12_345, metric, locale)).toBe('12.3K');
        expect(formatMetricValue(12_345_678, metric, locale)).toBe('12.3M');
      }

      expect(formatCompactDecimalCount('12345', locale)).toBe('12.3K');
      expect(formatCompactDecimalCount('12345678', locale)).toBe('12.3M');
    });
  }
});
