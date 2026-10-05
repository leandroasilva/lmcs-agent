import mysql from "mysql2/promise";
import { config } from "../config.js";
import fs from "fs";
import path from "path";

export async function runMigrations(dbConfig: typeof config.database) {
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.name,
  });

  try {
    // Create migrations table if not exists
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Get applied migrations
    const [appliedRows] = await connection.execute(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const appliedVersions = new Set((appliedRows as any[]).map((row) => row.version));

    // Get migration files
    const migrationsDir = path.join(process.cwd(), "migrations", "mysql");
    if (!fs.existsSync(migrationsDir)) {
      console.log("No migrations directory found");
      return;
    }

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    // Run pending migrations
    for (const file of migrationFiles) {
      const version = file.replace(".sql", "");

      if (appliedVersions.has(version)) {
        console.log(`Migration ${version} already applied, skipping`);
        continue;
      }

      console.log(`Applying migration ${version}...`);
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, "utf-8");

      // Split by semicolon and execute each statement
      const statements = sql.split(";").filter((s) => s.trim().length > 0);
      for (const statement of statements) {
        await connection.execute(statement);
      }

      // Record migration
      await connection.execute("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      console.log(`Migration ${version} applied successfully`);
    }

    console.log("All migrations completed");
  } finally {
    await connection.end();
  }
}
