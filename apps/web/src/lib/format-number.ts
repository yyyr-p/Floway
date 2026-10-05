import { NO_READING } from './no-reading';

const decimals = (value: number, maximumFractionDigits: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);

// Two fraction digits at the top of the ladder keep the whole range at three significant figures.
export const formatBytes = (value: number, locale: string): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${decimals(value / 1024, value < 10 * 1024 ? 1 : 0, locale)} KB`;
  if (value < 1024 ** 3) return `${decimals(value / 1024 ** 2, value < 10 * 1024 ** 2 ? 1 : 0, locale)} MB`;
  return `${decimals(value / 1024 ** 3, 2, locale)} GB`;
};

// `Intl` rather than a hand-rolled thousands ladder: zh-Hans groups by 万, not K.
export const formatCompactCount = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

const tokenScales = [
  { factor: 1_000, suffix: 'K' },
  { factor: 1_000_000, suffix: 'M' },
  { factor: 1_000_000_000, suffix: 'B' },
  { factor: 1_000_000_000_000, suffix: 'T' },
] as const;
const compactPromotionThreshold = 1_000 - 0.5 / 10;

// The scale is fixed to base 1000; only the mantissa follows the active locale.
export const formatCompactTokenCount = (value: number, locale: string): string => {
  const magnitude = Math.abs(value);
  let scaleIndex = -1;
  for (let index = tokenScales.length - 1; index >= 0; index -= 1) {
    if (magnitude >= tokenScales[index]!.factor) {
      scaleIndex = index;
      break;
    }
  }
  if (scaleIndex < 0) {
    if (magnitude < compactPromotionThreshold) return decimals(value, 1, locale);
    scaleIndex = 0;
  }

  while (scaleIndex < tokenScales.length - 1 && magnitude / tokenScales[scaleIndex]!.factor >= compactPromotionThreshold) {
    scaleIndex += 1;
  }
  const scale = tokenScales[scaleIndex]!;
  return `${decimals(value / scale.factor, 1, locale)}${scale.suffix}`;
};

export const formatNumber = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale).format(value);

// Clamped at zero: a negative tally is an arithmetic artifact, not a quantity.
export const formatCount = (value: number, locale: string): string =>
  formatNumber(Math.max(0, Math.round(value)), locale);

// Three significant figures across the range, so a column of rates stays comparable digit by digit.
export const formatTokenRate = (tokensPerSecond: number | null): string => {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return NO_READING;
  if (tokensPerSecond >= 100) return `${Math.round(tokensPerSecond)} tok/s`;
  if (tokensPerSecond >= 10) return `${tokensPerSecond.toFixed(1)} tok/s`;
  return `${tokensPerSecond.toFixed(2)} tok/s`;
};

export const formatTokenRateFromTpot = (us: number | null): string =>
  us === null || us <= 0 ? NO_READING : formatTokenRate(1_000_000 / us);
