// Fork's additions to the shared user-creation/update body, extended over
// upstream's schemas so the shared file never carries fork fields. `extend`
// replaces a field outright when the key already exists, so this both adds
// `canViewGlobalUsage` and keeps upstream's remaining shape untouched.

import { z } from 'zod';

import { createUserBody, updateUserBody } from '../schemas.ts';

export const createUserBodyExtended = createUserBody.extend({
  canViewGlobalUsage: z.boolean().optional(),
});

export const updateUserBodyExtended = updateUserBody.extend({
  canViewGlobalUsage: z.boolean().optional(),
});
