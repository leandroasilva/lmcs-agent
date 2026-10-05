import { Router, type Router as ExpressRouter } from "express";
import * as Layer from "effect/Layer";
import { v4 as uuidv4 } from "uuid";
import { withDatabase } from "../db/index.js";
import { requireAuth } from "../auth/jwt.js";
import { config } from "../config.js";
import type { Request, Response } from "express";

export const createEnvironmentRouter = (layer: any): ExpressRouter => {
  const router = Router();

  // GET /environments - List all environments for the user
  router.get("/", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      const result = await withDatabase(async (db) => {
        const [rows] = await db.execute(
          "SELECT id, name, tunnel_url, status, created_at FROM environments WHERE user_id = ? ORDER BY created_at DESC",
          [user.sub],
        );
        return rows;
      }).pipe(layer.runPromise);

      res.json({ environments: result });
    } catch (error) {
      console.error("List environments error:", error);
      res.status(500).json({ error: "Failed to list environments" });
    }
  });

  // POST /environments - Create a new environment
  router.post("/", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const environmentId = uuidv4();

      await withDatabase(async (db) => {
        await db.execute(
          "INSERT INTO environments (id, user_id, name, status) VALUES (?, ?, ?, 'pending')",
          [environmentId, user.sub, name],
        );
      }).pipe(layer.runPromise);

      res.status(201).json({
        environment: {
          id: environmentId,
          name,
          status: "pending",
        },
      });
    } catch (error) {
      console.error("Create environment error:", error);
      res.status(500).json({ error: "Failed to create environment" });
    }
  });

  // GET /environments/:id - Get a specific environment
  router.get("/:id", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { id } = req.params;

      const result = await withDatabase(async (db) => {
        const [rows] = await db.execute(
          "SELECT id, name, tunnel_url, status, created_at FROM environments WHERE id = ? AND user_id = ?",
          [id, user.sub],
        );
        return (rows as any[])[0];
      }).pipe(layer.runPromise);

      if (!result) {
        return res.status(404).json({ error: "Environment not found" });
      }

      res.json({ environment: result });
    } catch (error) {
      console.error("Get environment error:", error);
      res.status(500).json({ error: "Failed to get environment" });
    }
  });

  // PUT /environments/:id - Update an environment
  router.put("/:id", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { id } = req.params;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }

      const result = await withDatabase(async (db) => {
        const [updateResult] = await db.execute(
          "UPDATE environments SET name = ? WHERE id = ? AND user_id = ?",
          [name, id, user.sub],
        );
        return updateResult;
      }).pipe(layer.runPromise);

      if ((result as any).affectedRows === 0) {
        return res.status(404).json({ error: "Environment not found" });
      }

      res.json({ environment: { id, name } });
    } catch (error) {
      console.error("Update environment error:", error);
      res.status(500).json({ error: "Failed to update environment" });
    }
  });

  // DELETE /environments/:id - Delete an environment
  router.delete("/:id", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { id } = req.params;

      const result = await withDatabase(async (db) => {
        const [deleteResult] = await db.execute(
          "DELETE FROM environments WHERE id = ? AND user_id = ?",
          [id, user.sub],
        );
        return deleteResult;
      }).pipe(layer.runPromise);

      if ((result as any).affectedRows === 0) {
        return res.status(404).json({ error: "Environment not found" });
      }

      res.status(204).send();
    } catch (error) {
      console.error("Delete environment error:", error);
      res.status(500).json({ error: "Failed to delete environment" });
    }
  });

  return router;
};
