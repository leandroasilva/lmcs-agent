import { Router } from "express";

export const createHealthRouter = () => {
  const router = Router();

  router.get("/health", async (req, res) => {
    res.json({
      status: "ok",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    });
  });

  return router;
};
