import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "./config.js";
export const sql = postgres(config.DATABASE_URL, { max: 10 });
// Drizzle customizes driver serializers; keep its client separate from raw SQL.
export const ormSql = postgres(config.DATABASE_URL, { max: 5 });
export const db = drizzle(ormSql);
export async function closeDb() {
  await Promise.all([sql.end(), ormSql.end()]);
}
