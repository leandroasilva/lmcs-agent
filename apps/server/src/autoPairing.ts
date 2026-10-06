/**
 * Auto-generate pairing links on server startup for headless/production mode.
 *
 * This module creates pairing links automatically when the server starts
 * in production mode, making it easy to connect clients without SSH access.
 */
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { buildPairingUrl } from "./startupAccess.ts";
import { ServerConfig } from "./config.ts";

/**
 * Generate a pairing link for production/headless mode
 */
const generateProductionPairingLink = Effect.fn("autoPairing.generate")(function* (input: {
  config: ServerConfig["Service"];
  baseUrl: string;
  label: string;
  ttl: Duration.Duration;
}) {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

  const issued = yield* environmentAuth.createPairingLink({
    scopes: [
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
    ],
    subject: "one-time-token",
    label: input.label,
    ttl: input.ttl,
  });

  const pairingUrl = buildPairingUrl(input.baseUrl, issued.credential);

  return {
    pairingUrl,
    credential: issued.credential,
    expiresAt: issued.expiresAt,
    label: issued.label ?? input.label,
  };
});

/**
 * Display pairing links in a user-friendly format
 */
const displayPairingLinks = (
  links: Array<{
    pairingUrl: string;
    label: string;
    expiresAt: DateTime.Utc;
  }>,
) => {
  const separator = "═".repeat(70);
  const thinSeparator = "─".repeat(70);

  const output = [
    "",
    separator,
    "🔗 PAIRING LINKS - Conecte seus dispositivos ao servidor LMCS Code",
    separator,
    "",
    ...links.flatMap((link, index) => [
      `📱 Dispositivo ${index + 1}: ${link.label}`,
      thinSeparator,
      `URL: ${link.pairingUrl}`,
      `Expira: ${DateTime.formatIso(link.expiresAt)}`,
      "",
    ]),
    "💡 Como usar:",
    "  1. Abra o app LMCS Code (desktop, web ou mobile)",
    "  2. Cole a URL acima no campo 'Pairing link'",
    "  3. Clique em 'Pair' para conectar",
    "",
    "️  Estes links têm validade limitada. Após expirar, execute:",
    "    lmcs pair",
    "",
    separator,
    "",
  ].join("\n");

  return Console.log(output);
};

/**
 * Auto-generate pairing links on startup for production mode
 */
export const autoGeneratePairingLinks = Effect.fn("autoPairing")(function* (input: {
  config: ServerConfig["Service"];
  baseUrl: string;
}) {
  // Only generate in production/headless mode
  if (input.config.startupPresentation !== "headless") {
    return;
  }

  yield* Console.log("🔐 Generating pairing links for production mode...");

  // Generate 3 links with different TTLs
  const links = yield* Effect.all([
    generateProductionPairingLink({
      config: input.config,
      baseUrl: input.baseUrl,
      label: "Mobile Device",
      ttl: Duration.hours(24),
    }),
    generateProductionPairingLink({
      config: input.config,
      baseUrl: input.baseUrl,
      label: "Desktop Computer",
      ttl: Duration.hours(24),
    }),
    generateProductionPairingLink({
      config: input.config,
      baseUrl: input.baseUrl,
      label: "Web Browser",
      ttl: Duration.hours(24),
    }),
  ]);

  yield* displayPairingLinks(links);
});
