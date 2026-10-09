import type { Sql } from "postgres";
export function cleanupKnowledgeFixtures(
  sql: Sql,
  organizationId: string,
): Promise<void>;
