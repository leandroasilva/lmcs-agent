import { useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Alert, AlertDescription } from "../../ui/alert";
import { Loader2, Link as LinkIcon, AlertCircle, CheckCircle2 } from "lucide-react";

interface RemoteDeviceFormData {
  serverUrl: string;
  deviceToken: string;
  deviceName: string;
}

interface DeviceInfo {
  deviceId: string;
  token: string;
  name: string;
  platform: string;
  registeredAt: number;
  lastSeenAt: number;
  connected: boolean;
}

export function ConnectRemoteDeviceSettings() {
  const [formData, setFormData] = useState<RemoteDeviceFormData>({
    serverUrl: "",
    deviceToken: "",
    deviceName: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      // Validate the token by checking if the device exists
      const response = await fetch(`/api/devices/by-token/${formData.deviceToken}`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Device not found. Please check the token and try again.");
        }
        throw new Error("Failed to validate device token");
      }

      const device: DeviceInfo = await response.json();

      // Save the connection to localStorage
      const connections = JSON.parse(localStorage.getItem("remoteDeviceConnections") || "[]");
      const newConnection = {
        deviceId: device.deviceId,
        serverUrl: formData.serverUrl.replace(/\/$/, ""),
        deviceToken: formData.deviceToken,
        deviceName: formData.deviceName || device.name,
        platform: device.platform,
        addedAt: Date.now(),
      };

      // Check if connection already exists
      const existingIndex = connections.findIndex(
        (c: { deviceId: string }) => c.deviceId === device.deviceId,
      );

      if (existingIndex >= 0) {
        connections[existingIndex] = newConnection;
      } else {
        connections.push(newConnection);
      }

      localStorage.setItem("remoteDeviceConnections", JSON.stringify(connections));
      setSuccess(true);

      // Reset form
      setFormData({ serverUrl: "", deviceToken: "", deviceName: "" });

      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error("Failed to connect to device:", err);
      setError(err instanceof Error ? err.message : "Failed to connect to device");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="font-medium">Connect to Remote Device</div>
        <div className="text-muted-foreground text-sm">
          Add a remote device using its token. You'll be able to connect to it and collaborate.
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <Alert variant="error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert variant="success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>Device connected successfully!</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="server-url">Server URL</Label>
          <Input
            id="server-url"
            type="url"
            placeholder="https://your-server.example.com"
            value={formData.serverUrl}
            onChange={(e) => setFormData({ ...formData, serverUrl: e.target.value })}
            required
          />
          <p className="text-xs text-muted-foreground">
            The URL of the LMCS Code server where the device is registered.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="device-token">Device Token</Label>
          <Input
            id="device-token"
            type="text"
            placeholder="Enter the 32-character device token"
            value={formData.deviceToken}
            onChange={(e) => setFormData({ ...formData, deviceToken: e.target.value })}
            required
            maxLength={32}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            The unique token from the device you want to connect to.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="device-name">Device Name (optional)</Label>
          <Input
            id="device-name"
            type="text"
            placeholder="e.g., John's MacBook Pro"
            value={formData.deviceName}
            onChange={(e) => setFormData({ ...formData, deviceName: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            A friendly name to identify this device in your connections list.
          </p>
        </div>

        <Button type="submit" disabled={loading} className="w-full">
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Connecting...
            </>
          ) : (
            <>
              <LinkIcon className="mr-2 h-4 w-4" />
              Connect Device
            </>
          )}
        </Button>

        <Alert>
          <AlertDescription>
            <strong>Note:</strong> The device token is valid until regenerated. Make sure the remote
            device is online and registered with the server.
          </AlertDescription>
        </Alert>
      </form>
    </div>
  );
}
