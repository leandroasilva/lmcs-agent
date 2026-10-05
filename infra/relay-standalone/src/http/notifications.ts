import { Router, type Router as ExpressRouter } from "express";
import * as Layer from "effect/Layer";
import { withDatabase } from "../db/index.js";
import { requireAuth } from "../auth/jwt.js";
import { config } from "../config.js";
import type { Request, Response } from "express";
import { RedisClient } from "../queues/redis.js";
import * as Effect from "effect/Effect";

export const createNotificationRouter = (layer: any): ExpressRouter => {
  const router = Router();

  // GET /notifications - Get user notifications
  router.get("/", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const redisKey = `notifications:${user.sub}`;

      const notifications = await Effect.gen(function* () {
        const redis = yield* RedisClient;
        const result = yield* Effect.tryPromise({
          try: () => redis.lrange(redisKey, 0, 49),
          catch: (error) => new Error(`Redis error: ${error}`),
        });
        return result;
      }).pipe(layer.runPromise);

      const parsed = notifications.map((n) => JSON.parse(n));
      res.json({ notifications: parsed });
    } catch (error) {
      console.error("Get notifications error:", error);
      res.status(500).json({ error: "Failed to get notifications" });
    }
  });

  // DELETE /notifications/:id - Delete a notification
  router.delete("/:id", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { id } = req.params;
      const redisKey = `notifications:${user.sub}`;

      await Effect.gen(function* () {
        const redis = yield* RedisClient;
        yield* Effect.tryPromise({
          try: () => redis.lrem(redisKey, 1, id),
          catch: (error) => new Error(`Redis error: ${error}`),
        });
      }).pipe(layer.runPromise);

      res.status(204).send();
    } catch (error) {
      console.error("Delete notification error:", error);
      res.status(500).json({ error: "Failed to delete notification" });
    }
  });

  return router;
};
