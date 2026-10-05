// Fork's export format version, patched over upstream's import body so the
// shared file never carries fork's number. `extend` replaces the `version`
// literal outright: fork's export is a superset of upstream's format and
// stamps its own version, while upstream's body is still accepted on the wire
// by the same handler contract.

import { z } from 'zod';

import { importBody } from '../schemas.ts';

export const importBodyExtended = importBody.extend({
  version: z.literal(26, { error: 'version must be 26 — older export formats are not supported; re-export from the current deployment' }),
});
