# Web-App Integration für Download-Links

## Übersicht

Dieses Dokument beschreibt, wie die Web-App Download-Links für die Broadify Bridge Desktop App bereitstellen kann.

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
