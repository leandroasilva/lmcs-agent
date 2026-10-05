import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { createDatabaseLayer } from "./db/index.js";
import { createRedisLayer } from "./queues/redis.js";
import { createAuthRouter } from "./http/auth.js";
import { createEnvironmentRouter } from "./http/environments.js";
import { createHealthRouter } from "./http/health.js";
import { createTunnelRouter } from "./http/tunnels.js";
import { runMigrations } from "./db/migrate.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const app = express();

// Middleware
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
const healthRouter = createHealthRouter();
app.use("/", healthRouter);

// Create runtime layers
const runtimeLayer = Layer.mergeAll(
  createDatabaseLayer(config.database),
  createRedisLayer(config.redis),
);

// API routes (protected)
const authRouter = createAuthRouter(runtimeLayer);
const environmentRouter = createEnvironmentRouter(runtimeLayer);
const tunnelRouter = createTunnelRouter(runtimeLayer);

app.use("/auth", authRouter);
app.use("/environments", environmentRouter);
app.use("/tunnels", tunnelRouter);

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(config.nodeEnv === "development" && { stack: err.stack }),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Start server
async function start() {
  try {
    // Run migrations
    console.log("Running database migrations...");
    await runMigrations(config.database);
    console.log("Migrations completed");

    // Start server
    app.listen(config.port, config.host, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   LMCS Relay Standalone v1.0.0                           ║
║                                                           ║
║   Server:    http://${config.host}:${config.port}                ║
║   Domain:    ${config.relayDomain}                        ║
║   Database:  ${config.database.host}:${config.database.port}     ║
║   Redis:     ${config.redis.host}:${config.redis.port}           ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();
