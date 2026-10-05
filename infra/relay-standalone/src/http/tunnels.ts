import { Router } from "express";
import type { Layer } from "effect/Layer";

export const createTunnelRouter = (layer: Layer.Layer) => {
  const router = Router();

  // TODO: Implementar gerenciamento de tunnels
  // GET /tunnels
  // POST /tunnels
  // DELETE /tunnels/:id

  router.get("/", async (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
  });

  return router;
};
