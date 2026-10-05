import type { UsagePricingBackfillRepo } from './types.ts';
import { applyPlan, buildPlan, inspectDatabase, type BackfillIntent, type BackfillPlan, type DatabaseIdentity, type SqlStatement, type ToolDatabase } from '../usage-pricing-backfill/index.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export class SqlUsagePricingBackfillRepo implements UsagePricingBackfillRepo {
  readonly databaseIdentity: DatabaseIdentity;
  private readonly database: ToolDatabase;

  constructor(db: SqlDatabase, databaseIdentity: DatabaseIdentity) {
    this.databaseIdentity = databaseIdentity;
    this.database = {
      identity: databaseIdentity,
      query: async <Row>(statement: SqlStatement) => {
        const result = await db.prepare(statement.sql).bind(...(statement.params ?? [])).all<Row>();
        return { rows: result.results, changes: null };
      },
      execute: async statement => {
        const result = await db.prepare(statement.sql).bind(...(statement.params ?? [])).run();
        return { rows: [], changes: result.meta.changes ?? null };
      },
      close: () => Promise.resolve(),
    };
  }

  inspect(): Promise<Awaited<ReturnType<typeof inspectDatabase>>> {
    return inspectDatabase(this.database);
  }

  async plan(intent: BackfillIntent): Promise<BackfillPlan> {
    const built = await buildPlan(this.database, intent);
    return built.plan;
  }

  apply(plan: BackfillPlan): Promise<Awaited<ReturnType<typeof applyPlan>>> {
    return applyPlan(this.database, plan);
  }
}
