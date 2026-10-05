import type { Context } from 'hono';

import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { normalizeIntent, parsePlan, ToolError } from '../../usage-pricing-backfill/index.ts';
import type { usagePricingBackfillApplyBody, usagePricingBackfillPlanBody } from '../schemas.ts';

export const inspectUsagePricingBackfill = async (c: Context) =>
  c.json(await getRepo().usagePricingBackfill.inspect());

const errorResponse = (c: Context, cause: unknown) => {
  if (!(cause instanceof ToolError)) throw cause;
  if (cause.exitCode !== 2 && cause.exitCode !== 3) throw cause;
  const status = cause.exitCode === 2 ? 400 : 409;
  return c.json({ error: cause.message }, status);
};

export const planUsagePricingBackfill = async (c: CtxWithJson<typeof usagePricingBackfillPlanBody>) => {
  try {
    const intent = normalizeIntent(c.req.valid('json'));
    return c.json(await getRepo().usagePricingBackfill.plan(intent));
  } catch (cause) {
    return errorResponse(c, cause);
  }
};

export const applyUsagePricingBackfill = async (c: CtxWithJson<typeof usagePricingBackfillApplyBody>) => {
  try {
    const { plan: rawPlan, confirmationPlanId } = c.req.valid('json');
    const plan = await parsePlan(JSON.stringify(rawPlan));
    if (confirmationPlanId !== plan.planId) {
      return c.json({ error: 'Confirmation must match the current plan ID' }, 400);
    }
    // Plans remain stateless across Node and Worker runtimes: apply hashes the
    // submitted snapshot, then rebuilds and compares it against live rows,
    // upstream config, and pricing before the guarded write.
    return c.json(await getRepo().usagePricingBackfill.apply(plan));
  } catch (cause) {
    return errorResponse(c, cause);
  }
};
