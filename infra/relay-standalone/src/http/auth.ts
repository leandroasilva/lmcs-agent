import { Router } from "express";
import type { Layer } from "effect/Layer";
import { v4 as uuidv4 } from "uuid";
import { Database, withDatabase } from "../db/index.js";
import { config } from "../config.js";
import {
  createJwtToken,
  verifyJwtToken,
  hashPassword,
  comparePassword,
  generateRefreshToken,
  requireAuth,
} from "../auth/jwt.js";
import type { Request, Response } from "express";

export const createAuthRouter = (layer: Layer.Layer) => {
  const router = Router();

  // POST /auth/register
  router.post("/register", async (req: Request, res: Response) => {
    try {
      const { email, password, name } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const userId = uuidv4();
      const passwordHash = await hashPassword(password);

      await withDatabase(async (db) => {
        await db.execute({
          sql: "INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)",
          args: [userId, email, passwordHash, name || null],
        });
      }).pipe(layer.runPromise);

      const token = await createJwtToken({ sub: userId, email }, config.jwt);

      res.status(201).json({
        user: { id: userId, email, name },
        token,
      });
    } catch (error: any) {
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Email already registered" });
      }
      console.error("Register error:", error);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  // POST /auth/login
  router.post("/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const result = await withDatabase(async (db) => {
        const [rows] = await db.execute({
          sql: "SELECT id, email, password_hash, name FROM users WHERE email = ?",
          args: [email],
        });
        return rows[0] as any;
      }).pipe(layer.runPromise);

      if (!result) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const validPassword = await comparePassword(password, result.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = await createJwtToken({ sub: result.id, email: result.email }, config.jwt);

      res.json({
        user: { id: result.id, email: result.email, name: result.name },
        token,
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // POST /auth/refresh
  router.post("/refresh", async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing token" });
      }

      const token = authHeader.substring(7);
      const payload = await verifyJwtToken(token, config.jwt.secret);

      const newToken = await createJwtToken({ sub: payload.sub, email: payload.email }, config.jwt);

      res.json({ token: newToken });
    } catch (error) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  });

  // GET /auth/me (protected)
  router.get("/me", requireAuth(config.jwt.secret), async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      const result = await withDatabase(async (db) => {
        const [rows] = await db.execute({
          sql: "SELECT id, email, name, created_at FROM users WHERE id = ?",
          args: [user.sub],
        });
        return rows[0] as any;
      }).pipe(layer.runPromise);

      if (!result) {
        return res.status(404).json({ error: "User not found" });
      }

      res.json({ user: result });
    } catch (error) {
      console.error("Get user error:", error);
      res.status(500).json({ error: "Failed to get user" });
    }
  });

  return router;
};
