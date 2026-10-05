import { Router } from "express";
import type { Layer } from "effect/Layer";

export const createAuthRouter = (layer: Layer.Layer) => {
  const router = Router();

  // TODO: Implementar autenticação JWT própria
  // POST /auth/register
  // POST /auth/login
  // POST /auth/refresh
  // POST /auth/logout

  router.post("/register", async (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
  });

  router.post("/login", async (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
  });

  router.post("/refresh", async (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
  });

  router.post("/logout", async (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
  });

  return router;
};
