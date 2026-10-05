import type { UsageLimitWindow } from './types.ts';

const hourStamp = (date: Date): string => date.toISOString().slice(0, 13);

export const usageLimitWindowBounds = (now: Date): Record<UsageLimitWindow, { start: string; end: string }> => {
  const hourStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    hour: { start: hourStamp(hourStart), end: hourStamp(new Date(hourStart.getTime() + 3_600_000)) },
    day: { start: hourStamp(dayStart), end: hourStamp(new Date(dayStart.getTime() + 86_400_000)) },
    month: { start: hourStamp(monthStart), end: hourStamp(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))) },
  };
};
