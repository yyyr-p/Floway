import type { User } from './types.ts';

export const canViewGlobalUsage = (user: Pick<User, 'isAdmin' | 'canViewGlobalUsage'>): boolean =>
  user.isAdmin || user.canViewGlobalUsage;
