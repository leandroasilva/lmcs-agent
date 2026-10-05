import mysql from "mysql2/promise";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface DatabaseConfig {
  url: string;
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
}

export class Database extends Context.Tag("Database")<Database, mysql.Pool>() {}

export const createDatabaseLayer = (config: DatabaseConfig) => {
  return Layer.effect(
    Database,
    Effect.tryPromise({
      try: async () => {
        const pool = mysql.createPool({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.name,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
        });

        // Test connection
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();

        console.log("Database connected successfully");
        return pool;
      },
      catch: (error) => new Error(`Database connection failed: ${error}`),
    }),
  );
};

export const withDatabase = <A>(f: (db: mysql.Pool) => Promise<A>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* Effect.tryPromise({
      try: () => f(db),
      catch: (error) => new Error(`Database operation failed: ${error}`),
    });
  });
