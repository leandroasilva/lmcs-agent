import mysql from "mysql2/promise";
import { config } from "../config.js";

export async function runMigrations(dbConfig: typeof config.database) {
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.name,
  });

  // TODO: Implementar sistema de migrations
  console.log("Migrations completed (stub)");

  await connection.end();
}
