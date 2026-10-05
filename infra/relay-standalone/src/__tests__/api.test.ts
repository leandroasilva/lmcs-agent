import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { createAuthRouter } from "../http/auth.js";
import { createHealthRouter } from "../http/health.js";
import { createEnvironmentRouter } from "../http/environments.js";
import { createTunnelRouter } from "../http/tunnels.js";
import { createNotificationRouter } from "../http/notifications.js";
import * as Layer from "effect/Layer";

// Mock layer for testing
const mockLayer = Layer.succeed({} as any);

describe("Health Router", () => {
  const app = express();
  app.use("/", createHealthRouter());

  it("GET / should return status ok", async () => {
    const response = await request(app).get("/");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("Auth Router", () => {
  const app = express();
  app.use(express.json());
  app.use("/auth", createAuthRouter(mockLayer));

  it("POST /auth/register should create a new user", async () => {
    const response = await request(app).post("/auth/register").send({
      email: "test@example.com",
      password: "password123",
      name: "Test User",
    });

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty("user");
    expect(response.body).toHaveProperty("token");
    expect(response.body.user.email).toBe("test@example.com");
  });

  it("POST /auth/login should authenticate user", async () => {
    // First register
    await request(app).post("/auth/register").send({
      email: "login@example.com",
      password: "password123",
    });

    // Then login
    const response = await request(app).post("/auth/login").send({
      email: "login@example.com",
      password: "password123",
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("token");
  });

  it("POST /auth/login should fail with wrong password", async () => {
    const response = await request(app).post("/auth/login").send({
      email: "login@example.com",
      password: "wrongpassword",
    });

    expect(response.status).toBe(401);
  });
});

describe("Environment Router", () => {
  const app = express();
  app.use(express.json());
  app.use("/environments", createEnvironmentRouter(mockLayer));

  it("GET /environments should require authentication", async () => {
    const response = await request(app).get("/environments");
    expect(response.status).toBe(401);
  });
});

describe("Tunnel Router", () => {
  const app = express();
  app.use(express.json());
  app.use("/tunnels", createTunnelRouter(mockLayer));

  it("GET /tunnels should require authentication", async () => {
    const response = await request(app).get("/tunnels");
    expect(response.status).toBe(401);
  });
});

describe("Notification Router", () => {
  const app = express();
  app.use(express.json());
  app.use("/notifications", createNotificationRouter(mockLayer));

  it("GET /notifications should require authentication", async () => {
    const response = await request(app).get("/notifications");
    expect(response.status).toBe(401);
  });
});
