import * as jose from "jose";
import { v4 as uuidv4 } from "uuid";
import type { Request, Response, NextFunction } from "express";

export interface JwtPayload {
  sub: string; // user ID
  email: string;
  iat?: number;
  exp?: number;
}

export interface AuthConfig {
  secret: string;
  expiresIn: string;
}

const getSecretKey = (secret: string) => {
  return new TextEncoder().encode(secret);
};

export const createJwtToken = async (
  payload: Omit<JwtPayload, "iat" | "exp">,
  config: AuthConfig,
): Promise<string> => {
  const secret = getSecretKey(config.secret);
  const token = await new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(config.expiresIn)
    .sign(secret);
  return token;
};

export const verifyJwtToken = async (token: string, secret: string): Promise<JwtPayload> => {
  const secretKey = getSecretKey(secret);
  const { payload } = await jose.jwtVerify(token, secretKey);
  return payload as JwtPayload;
};

export const hashPassword = async (password: string): Promise<string> => {
  const saltRounds = 10;
  const salt = await import("bcrypt").then((m) => m.genSalt(saltRounds));
  return await import("bcrypt").then((m) => m.hash(password, salt));
};

export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
  return await import("bcrypt").then((m) => m.compare(password, hash));
};

export const generateRefreshToken = (): string => {
  return uuidv4();
};

// Express middleware
export const requireAuth = (secret: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid authorization header" });
      }

      const token = authHeader.substring(7);
      const payload = await verifyJwtToken(token, secret);

      (req as any).user = payload;
      next();
    } catch (error) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
};
