import { initializeStorage } from "./app.js";
import { sql } from "./db.js";
try {
  await initializeStorage();
  console.log("Object storage bucket ready");
} finally {
  await sql.end();
}
