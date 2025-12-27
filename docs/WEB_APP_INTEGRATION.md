# Web-App Integration

## Übersicht

Dieses Dokument beschreibt:
1. Wie die Web-App mit der Broadify Bridge Desktop App verbindet (Bridge-Verbindung)
2. Wie die Web-App Download-Links für die Desktop App bereitstellen kann

---

## Bridge-Verbindung

### URL-Parameter-Struktur

Wenn die Desktop App die Web-App öffnet (z.B. nach "Launch GUI" Klick), werden folgende URL-Parameter übergeben:

#### Production Mode

In Production wird ein Cloudflare Tunnel verwendet, um die Bridge von der Web-App (app.broadify.de) erreichbar zu machen.

**URL-Parameter:**
- `tunnelUrl` (string, erforderlich): Die öffentliche Cloudflare Tunnel URL (z.B. `https://xxxxx.trycloudflare.com`)
- `useTunnel` (string): Immer `"true"` in Production
- `ip` (string, Fallback): Lokale IP-Adresse der Bridge (z.B. `192.168.1.100`)
- `port` (number, Fallback): Port der Bridge (z.B. `8787`)

**Beispiel Production URL:**
```
https://app.broadify.de/?tunnelUrl=https://xxxxx.trycloudflare.com&useTunnel=true&ip=192.168.1.100&port=8787
```

**Verwendung in Web-App:**
```typescript
const urlParams = new URLSearchParams(window.location.search);
const useTunnel = urlParams.get("useTunnel") === "true";
const tunnelUrl = urlParams.get("tunnelUrl");
const ip = urlParams.get("ip");
const port = urlParams.get("port");

// In Production: Verwende Tunnel-URL als primäre Verbindungsmethode
const bridgeBaseUrl = useTunnel && tunnelUrl 
  ? tunnelUrl  // https://xxxxx.trycloudflare.com
  : `http://${ip}:${port}`;  // Fallback: http://192.168.1.100:8787

// Alle Bridge-API-Requests verwenden bridgeBaseUrl
const response = await fetch(`${bridgeBaseUrl}/status`);
```

#### Development Mode

In Development wird keine Tunnel-URL übergeben, da die Web-App direkt auf die lokale Bridge zugreifen kann.

**URL-Parameter:**
- `ip` (string, erforderlich): Lokale IP-Adresse der Bridge (z.B. `127.0.0.1` oder `192.168.1.100`)
- `iptype` (string): Interface-Typ (z.B. `"localhost"`, `"ethernet"`, `"wifi"`)
- `port` (number, erforderlich): Port der Bridge (z.B. `8787`)
- `useTunnel` (string): Immer `"false"` in Development

**Beispiel Development URL:**
```
http://localhost:5173/?ip=127.0.0.1&iptype=localhost&port=8787&useTunnel=false
```

**Verwendung in Web-App:**
```typescript
const urlParams = new URLSearchParams(window.location.search);
const useTunnel = urlParams.get("useTunnel") === "false"; // Development
const ip = urlParams.get("ip");
const port = urlParams.get("port");

// In Development: Verwende lokale IP
const bridgeBaseUrl = `http://${ip}:${port}`;  // http://127.0.0.1:8787

const response = await fetch(`${bridgeBaseUrl}/status`);
```

### Best Practices für Web-App

1. **Immer `useTunnel` Parameter prüfen**
   - `useTunnel === "true"`: Verwende `tunnelUrl` als primäre Verbindungsmethode
   - `useTunnel === "false"`: Verwende lokale IP (`ip:port`)

2. **Fallback-Mechanismus in Production**
   - Wenn `tunnelUrl` nicht verfügbar ist, verwende `ip:port` als Fallback
   - Logge Warnung, wenn Fallback verwendet wird

3. **Error Handling**
   - Wenn Tunnel-URL nicht erreichbar ist, versuche Fallback auf lokale IP
   - Zeige dem User eine klare Fehlermeldung

**Beispiel Implementation:**
```typescript
function getBridgeBaseUrl(): string {
  const urlParams = new URLSearchParams(window.location.search);
  const useTunnel = urlParams.get("useTunnel") === "true";
  const tunnelUrl = urlParams.get("tunnelUrl");
  const ip = urlParams.get("ip");
  const port = urlParams.get("port");

  if (!ip || !port) {
    throw new Error("Missing required bridge connection parameters");
  }

  if (useTunnel && tunnelUrl) {
    // Production: Use tunnel URL
    return tunnelUrl;
  } else {
    // Development or fallback: Use local IP
    return `http://${ip}:${port}`;
  }
}

// Usage
async function connectToBridge() {
  try {
    const bridgeUrl = getBridgeBaseUrl();
    const response = await fetch(`${bridgeUrl}/status`);
    if (!response.ok) {
      throw new Error(`Bridge not reachable at ${bridgeUrl}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to connect to bridge:", error);
    // Try fallback if tunnel failed
    const urlParams = new URLSearchParams(window.location.search);
    const ip = urlParams.get("ip");
    const port = urlParams.get("port");
    if (ip && port) {
      const fallbackUrl = `http://${ip}:${port}`;
      console.warn(`Trying fallback: ${fallbackUrl}`);
      // Retry with fallback...
    }
    throw error;
  }
}
```

### Environment Detection

Die Desktop App unterscheidet automatisch zwischen Production und Development:

- **Production**: `NODE_ENV !== "development"`
  - Tunnel wird automatisch gestartet
  - Tunnel-URL wird an Web-App übergeben
  - Tunnel-Fehler stoppen die Bridge (kritisch)

- **Development**: `NODE_ENV === "development"`
  - Tunnel wird NICHT gestartet
  - Nur lokale IP wird an Web-App übergeben
  - Bridge funktioniert auch ohne Tunnel

---

## Download-Links

## GitHub Releases API

### Endpoint

```
GET https://api.github.com/repos/{owner}/{repo}/releases/latest
```

### Beispiel Request

```javascript
const GITHUB_OWNER = "your-username";
const GITHUB_REPO = "broadify-bridge-v2";

async function getLatestRelease() {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
  );

  if (!response.ok) {
    throw new Error("Failed to fetch release");
  }

  return await response.json();
}
```

### Response Struktur

```typescript
interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}
```

## Plattform-Erkennung

### User-Agent basiert

```javascript
function detectPlatform() {
  const userAgent = navigator.userAgent.toLowerCase();

  if (userAgent.includes("mac")) {
    // macOS: Prüfe auf Apple Silicon vs Intel
    // Apple Silicon: navigator.platform === 'MacIntel' && navigator.hardwareConcurrency === 8
    // Für genauere Erkennung: navigator.userAgentData.platform (experimental)
    return "mac";
  } else if (userAgent.includes("win")) {
    return "windows";
  } else if (userAgent.includes("linux")) {
    return "linux";
  }

  return "unknown";
}
```

### Moderne API (experimental)

```javascript
async function detectPlatform() {
  if (navigator.userAgentData) {
    const platform = navigator.userAgentData.platform.toLowerCase();
    const isMac = platform.includes("mac");
    const isWindows = platform.includes("win");
    const isLinux = platform.includes("linux");

    if (isMac) {
      // Apple Silicon Erkennung
      // Note: Diese API ist noch experimentell
      return "mac";
    } else if (isWindows) {
      return "windows";
    } else if (isLinux) {
      return "linux";
    }
  }

  // Fallback zu User-Agent
  return detectPlatformFromUserAgent();
}
```

## Download-Link Mapping

### Asset-Namen Mapping

```javascript
function mapPlatformToAsset(platform, assets) {
  const assetMap = {
    mac: {
      arm64: assets.find((a) => a.name.includes("arm64.dmg")),
      x64: assets.find(
        (a) => a.name.includes("x64.dmg") && !a.name.includes("arm64")
      ),
    },
    windows: {
      portable: assets.find((a) => a.name.endsWith(".exe")),
      installer: assets.find((a) => a.name.endsWith(".msi")),
    },
    linux: {
      appimage: assets.find((a) => a.name.endsWith(".AppImage")),
    },
  };

  return assetMap[platform];
}
```

## Vollständiges Beispiel

```typescript
interface DownloadLinks {
  mac?: {
    arm64?: string;
    x64?: string;
  };
  windows?: {
    portable?: string;
    installer?: string;
  };
  linux?: {
    appimage?: string;
  };
}

async function getDownloadLinks(): Promise<DownloadLinks> {
  const release = await getLatestRelease();
  const assets = release.assets;

  return {
    mac: {
      arm64: assets.find((a) => a.name.includes("arm64.dmg"))
        ?.browser_download_url,
      x64: assets.find(
        (a) => a.name.includes("x64.dmg") && !a.name.includes("arm64")
      )?.browser_download_url,
    },
    windows: {
      portable: assets.find((a) => a.name.endsWith(".exe"))
        ?.browser_download_url,
      installer: assets.find((a) => a.name.endsWith(".msi"))
        ?.browser_download_url,
    },
    linux: {
      appimage: assets.find((a) => a.name.endsWith(".AppImage"))
        ?.browser_download_url,
    },
  };
}

// Verwendung
const links = await getDownloadLinks();
const platform = detectPlatform();

if (platform === "mac") {
  // Zeige beide Optionen oder wähle basierend auf Hardware
  const downloadUrl = links.mac?.arm64 || links.mac?.x64;
  window.location.href = downloadUrl;
} else if (platform === "windows") {
  // Zeige beide Optionen (Portable vs Installer)
  const downloadUrl = links.windows?.installer || links.windows?.portable;
  window.location.href = downloadUrl;
} else if (platform === "linux") {
  const downloadUrl = links.linux?.appimage;
  window.location.href = downloadUrl;
}
```

## React Hook Beispiel

```typescript
import { useState, useEffect } from "react";

interface DownloadInfo {
  version: string;
  links: DownloadLinks;
  loading: boolean;
  error: Error | null;
}

export function useDownloadLinks() {
  const [downloadInfo, setDownloadInfo] = useState<DownloadInfo>({
    version: "",
    links: {},
    loading: true,
    error: null,
  });

  useEffect(() => {
    async function fetchDownloadLinks() {
      try {
        const release = await getLatestRelease();
        const links = await getDownloadLinks();

        setDownloadInfo({
          version: release.tag_name.replace("v", ""),
          links,
          loading: false,
          error: null,
        });
      } catch (error) {
        setDownloadInfo((prev) => ({
          ...prev,
          loading: false,
          error: error as Error,
        }));
      }
    }

    fetchDownloadLinks();
  }, []);

  return downloadInfo;
}
```

## UI Komponente Beispiel

```tsx
import { useDownloadLinks } from "./hooks/useDownloadLinks";

export function DownloadButton() {
  const { links, loading, error, version } = useDownloadLinks();
  const platform = detectPlatform();

  if (loading) {
    return <button disabled>Loading...</button>;
  }

  if (error) {
    return <button disabled>Download unavailable</button>;
  }

  const getDownloadUrl = () => {
    if (platform === "mac") {
      return links.mac?.arm64 || links.mac?.x64;
    } else if (platform === "windows") {
      return links.windows?.installer || links.windows?.portable;
    } else if (platform === "linux") {
      return links.linux?.appimage;
    }
    return null;
  };

  const downloadUrl = getDownloadUrl();

  if (!downloadUrl) {
    return <button disabled>Platform not supported</button>;
  }

  return (
    <a href={downloadUrl} download className="download-button">
      Download Broadify Bridge {version}
    </a>
  );
}
```

## Caching

Für bessere Performance sollte die Release-Information gecacht werden:

```typescript
const CACHE_KEY = "broadify-bridge-release";
const CACHE_TTL = 60 * 60 * 1000; // 1 Stunde

async function getLatestReleaseCached() {
  const cached = localStorage.getItem(CACHE_KEY);

  if (cached) {
    const { data, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp < CACHE_TTL) {
      return data;
    }
  }

  const release = await getLatestRelease();
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      data: release,
      timestamp: Date.now(),
    })
  );

  return release;
}
```

## Error Handling

```typescript
async function getDownloadLinksWithFallback(): Promise<DownloadLinks | null> {
  try {
    return await getDownloadLinks();
  } catch (error) {
    console.error("Failed to fetch download links:", error);

    // Fallback: Direkter Link zum GitHub Releases Page
    return {
      fallback: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    };
  }
}
```

## Rate Limiting

GitHub API hat Rate Limits:

- Authenticated: 5,000 requests/hour
- Unauthenticated: 60 requests/hour

Für Production sollte ein Backend-Proxy verwendet werden, der die Requests cached:

```typescript
// Backend Endpoint
GET / api / releases / latest;

// Frontend
async function getLatestRelease() {
  const response = await fetch("/api/releases/latest");
  return await response.json();
}
```
