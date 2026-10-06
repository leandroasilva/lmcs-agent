import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Link as LinkIcon, AlertCircle, CheckCircle2 } from "lucide-react";

interface RemoteDeviceFormData {
  serverUrl: string;
  deviceToken: string;
  deviceName: string;
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
    setError(null);
    setSuccess(false);

    // Validate inputs
    if (!formData.serverUrl.trim()) {
      setError("Server URL is required");
      return;
    }

    if (!formData.deviceToken.trim()) {
      setError("Device token is required");
      return;
    }

    setLoading(true);

    try {
      // TODO: Implement actual connection logic
      // For now, just simulate a successful connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // In a real implementation, this would:
      // 1. Validate the token against the server
      // 2. Establish a connection to the remote device
      // 3. Save the connection to the catalog

      console.log("Connecting to remote device:", {
        serverUrl: formData.serverUrl,
        deviceToken: formData.deviceToken,
        deviceName: formData.deviceName || "Unnamed Device",
      });

      setSuccess(true);
      setFormData({ serverUrl: "", deviceToken: "", deviceName: "" });
    } catch (err) {
      setError("Failed to connect to remote device");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LinkIcon className="h-5 w-5" />
          Connect to Remote Device
        </CardTitle>
        <CardDescription>
          Connect to another desktop instance using its device token. You'll need the token from the
          remote device's Settings → Device Token page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert className="border-green-200 bg-green-50">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800">
                Successfully connected to remote device!
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="server-url">Server URL</Label>
            <Input
              id="server-url"
              type="url"
              placeholder="https://lmcs-agent.cloud.hcloud.net.br"
              value={formData.serverUrl}
              onChange={(e) => setFormData({ ...formData, serverUrl: e.target.value })}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              The URL of the LMCS Code server where the remote device is registered.
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
              disabled={loading}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              The unique token from the remote device. Find it in Settings → Device Token.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="device-name">Device Name (Optional)</Label>
            <Input
              id="device-name"
              type="text"
              placeholder="e.g., Work MacBook, Home PC"
              value={formData.deviceName}
              onChange={(e) => setFormData({ ...formData, deviceName: e.target.value })}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              A friendly name to identify this remote device.
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
                Connect to Device
              </>
            )}
          </Button>

          <Alert>
            <AlertDescription>
              <strong>How to get the token:</strong> On the remote device, open Settings → Device
              Token, copy the token, and paste it here. The token is unique to each device and can
              be regenerated if compromised.
            </AlertDescription>
          </Alert>
        </form>
      </CardContent>
    </Card>
  );
}
