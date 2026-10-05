import { Router, type Router as ExpressRouter } from "express";
import * as Layer from "effect/Layer";
import { v4 as uuidv4 } from "uuid";
import { withDatabase } from "../db/index.js";
import { requireAuth } from "../auth/jwt.js";
import { config } from "../config.js";
import type { Request, Response } from "express";

export const createTunnelRouter = (layer: any): ExpressRouter => {
  const router = Router();

  // GET /tunnels - List all tunnels for the user
  router.get("/", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      const result = await withDatabase(async (db) => {
        const [rows] = await db.execute(
          `SELECT t.id, t.environment_id, t.tunnel_url, t.status, t.created_at, e.name as environment_name
           FROM tunnels t
           INNER JOIN environments e ON t.environment_id = e.id
           WHERE e.user_id = ?
           ORDER BY t.created_at DESC`,
          [user.sub],
        );
        return rows;
      }).pipe(layer.runPromise);

      res.json({ tunnels: result });
    } catch (error) {
      console.error("List tunnels error:", error);
      res.status(500).json({ error: "Failed to list tunnels" });
    }
  });

  // POST /tunnels - Create a new tunnel for an environment
  router.post("/", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { environment_id, tunnel_url } = req.body;

      if (!environment_id || !tunnel_url) {
        return res.status(400).json({ error: "environment_id and tunnel_url are required" });
      }

      // Verify environment belongs to user
      const envCheck = await withDatabase(async (db) => {
        const [rows] = await db.execute(
          "SELECT id FROM environments WHERE id = ? AND user_id = ?",
          [environment_id, user.sub],
        );
        return (rows as any[])[0];
      }).pipe(layer.runPromise);

      if (!envCheck) {
        return res.status(404).json({ error: "Environment not found" });
      }

      const tunnelId = uuidv4();

      await withDatabase(async (db) => {
        await db.execute(
          "INSERT INTO tunnels (id, environment_id, tunnel_url, status) VALUES (?, ?, ?, 'active')",
          [tunnelId, environment_id, tunnel_url],
        );
      }).pipe(layer.runPromise);

      res.status(201).json({
        tunnel: {
          id: tunnelId,
          environment_id,
          tunnel_url,
          status: "active",
        },
      });
    } catch (error) {
      console.error("Create tunnel error:", error);
      res.status(500).json({ error: "Failed to create tunnel" });
    }
  });

  // DELETE /tunnels/:id - Delete a tunnel
  router.delete("/:id", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { id } = req.params;

      const result = await withDatabase(async (db) => {
        const [deleteResult] = await db.execute(
          `DELETE t FROM tunnels t
           INNER JOIN environments e ON t.environment_id = e.id
           WHERE t.id = ? AND e.user_id = ?`,
          [id, user.sub],
        );
        return deleteResult;
      }).pipe(layer.runPromise);

      if ((result as any).affectedRows === 0) {
        return res.status(404).json({ error: "Tunnel not found" });
      }

      res.status(204).send();
    } catch (error) {
      console.error("Delete tunnel error:", error);
      res.status(500).json({ error: "Failed to delete tunnel" });
    }
  });

  return router;
};
