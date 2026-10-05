import { Router } from "express";
import type { Layer } from "effect/Layer";

export const createEnvironmentRouter = (layer: Layer.Layer) => {
  const router = Router();

  // TODO: Implementar gerenciamento de ambientes
  // GET /environments
  // POST /environments
  // GET /environments/:id
  // PUT /environments/:id
  // DELETE /environments/:id
  // POST /environments/:id/link
  // POST /environments/:id/unlink

  router.get("/", async (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
  });

  return router;
};
