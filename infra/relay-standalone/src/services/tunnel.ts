import { execSync, spawn } from "child_process";
import { config } from "../config.js";

export interface TunnelConfig {
  environmentId: string;
  tunnelUrl: string;
  localPort: number;
}

export class CloudflareTunnelService {
  private activeTunnels: Map<string, any> = new Map();

  /**
   * Create a new Cloudflare tunnel for an environment
   */
  async createTunnel(tunnelConfig: TunnelConfig): Promise<string> {
    const tunnelId = `tunnel-${tunnelConfig.environmentId}`;

    try {
      // Check if cloudflared is installed
      execSync("which cloudflared", { stdio: "pipe" });

      // Create tunnel command
      const args = [
        "tunnel",
        "--url",
        `http://localhost:${tunnelConfig.localPort}`,
        "--no-autoupdate",
      ];

      if (config.relayDomain) {
        args.push("--hostname", config.relayDomain);
      }

      // Start cloudflared process
      const process = spawn("cloudflared", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeTunnels.set(tunnelId, process);

      // Wait for tunnel URL
      const tunnelUrl = await this.waitForTunnelUrl(process);

      return tunnelUrl;
    } catch (error) {
      console.error("Failed to create tunnel:", error);
      throw new Error("Tunnel creation failed");
    }
  }

  /**
   * Delete a tunnel
   */
  async deleteTunnel(environmentId: string): Promise<void> {
    const tunnelId = `tunnel-${environmentId}`;
    const process = this.activeTunnels.get(tunnelId);

    if (process) {
      process.kill();
      this.activeTunnels.delete(tunnelId);
    }
  }

  /**
   * Get tunnel URL from cloudflared output
   */
  private waitForTunnelUrl(process: any): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Tunnel creation timeout"));
      }, 30000);

      process.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);

        if (urlMatch) {
          clearTimeout(timeout);
          resolve(urlMatch[0]);
        }
      });

      process.stderr.on("data", (data: Buffer) => {
        console.error("Cloudflared stderr:", data.toString());
      });

      process.on("error", (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Get all active tunnels
   */
  getActiveTunnels(): string[] {
    return Array.from(this.activeTunnels.keys());
  }
}

export const tunnelService = new CloudflareTunnelService();
