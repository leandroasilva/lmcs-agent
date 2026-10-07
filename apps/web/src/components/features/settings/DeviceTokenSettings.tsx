import { useState, useEffect } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Alert, AlertDescription } from "../../ui/alert";
import { Copy, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";

export function DeviceTokenSettings() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDesktop = typeof window.desktopBridge !== "undefined";

  useEffect(() => {
    if (!isDesktop) {
      setLoading(false);
      return;
    }

    loadToken();
  }, [isDesktop]);

  const loadToken = async () => {
    if (!isDesktop || !window.desktopBridge?.getDeviceToken) {
      setLoading(false);
      return;
    }

    try {
      const deviceToken = await window.desktopBridge.getDeviceToken();
      setToken(deviceToken);
      setError(null);
    } catch (err) {
      setError("Failed to load device token");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!token) return;

    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleRegenerate = async () => {
    if (!isDesktop || !window.desktopBridge?.regenerateDeviceToken) return;

    setRegenerating(true);
    try {
      const newToken = await window.desktopBridge.regenerateDeviceToken();
      setToken(newToken);
      setError(null);
    } catch (err) {
      setError("Failed to regenerate token");
      console.error(err);
    } finally {
      setRegenerating(false);
    }
  };

  if (!isDesktop) {
    return (
      <div className="rounded-xl border px-3.5 py-3 text-sm">
        <div className="font-medium">Device Token</div>
        <div className="text-muted-foreground text-sm">
          Device tokens are only available in the desktop app.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-xl border px-3.5 py-3 text-sm">
        <div className="font-medium">Device Token</div>
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="font-medium">Device Token</div>
        <div className="text-muted-foreground text-sm">
          Share this token with other users to allow them to connect to this device. The token
          uniquely identifies this desktop instance.
        </div>
      </div>

      <div className="space-y-2">
        {error && (
          <Alert variant="error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="device-token">Your Device Token</Label>
          <div className="flex gap-2">
            <Input id="device-token" value={token ?? ""} readOnly className="font-mono text-sm" />
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              disabled={!token}
              title="Copy to clipboard"
            >
              {copied ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={handleRegenerate}
              disabled={regenerating || !token}
              title="Regenerate token (invalidates previous)"
            >
              <RefreshCw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {copied
              ? "Token copied to clipboard!"
              : "This token is unique to this device. Regenerating will invalidate the previous token."}
          </p>
        </div>

        <Alert>
          <AlertDescription>
            <strong>How to connect:</strong> Share your token with another user. They can add your
            device using this token and the server URL.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
