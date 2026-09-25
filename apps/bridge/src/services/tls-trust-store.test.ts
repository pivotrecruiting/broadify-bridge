import {
  isSystemCaEnabled,
  resolveSystemCaSource,
  resolveTlsTrustStoreStatus,
  type CaCertificateTypeT,
} from "./tls-trust-store.js";

const fakeCertificates =
  (counts: Partial<Record<CaCertificateTypeT, number>>) =>
  (type: CaCertificateTypeT): string[] =>
    Array.from({ length: counts[type] ?? 0 }, () => "PEM");

describe("resolveSystemCaSource", () => {
  it("reports off when nothing enables the system store", () => {
    expect(resolveSystemCaSource({}, [])).toBe("off");
  });

  it("treats only the literal value 1 of NODE_USE_SYSTEM_CA as enabled", () => {
    expect(resolveSystemCaSource({ NODE_USE_SYSTEM_CA: "1" }, [])).toBe("env");
    for (const value of ["0", "", "true", "yes", " 1"]) {
      expect(resolveSystemCaSource({ NODE_USE_SYSTEM_CA: value }, [])).toBe("off");
    }
  });

  it("detects the CLI flag and NODE_OPTIONS", () => {
    expect(resolveSystemCaSource({}, ["--use-system-ca"])).toBe("flag");
    expect(
      resolveSystemCaSource(
        { NODE_OPTIONS: "--max-old-space-size=4096 --use-system-ca" },
        []
      )
    ).toBe("node_options");
    expect(
      resolveSystemCaSource({ NODE_OPTIONS: "--use-system-ca-not-really" }, [])
    ).toBe("off");
  });

  it("prefers the CLI flag over NODE_OPTIONS and the env variable", () => {
    const env = { NODE_USE_SYSTEM_CA: "1", NODE_OPTIONS: "--use-system-ca" };
    expect(resolveSystemCaSource(env, ["--use-system-ca"])).toBe("flag");
    expect(resolveSystemCaSource(env, [])).toBe("node_options");
  });
});

describe("isSystemCaEnabled", () => {
  it("is true for every enabling source and false otherwise", () => {
    expect(isSystemCaEnabled({}, [])).toBe(false);
    expect(isSystemCaEnabled({ NODE_USE_SYSTEM_CA: "0" }, [])).toBe(false);
    expect(isSystemCaEnabled({ NODE_USE_SYSTEM_CA: "1" }, [])).toBe(true);
    expect(isSystemCaEnabled({ NODE_OPTIONS: "--use-system-ca" }, [])).toBe(true);
    expect(isSystemCaEnabled({}, ["--use-system-ca"])).toBe(true);
  });
});

describe("resolveTlsTrustStoreStatus", () => {
  it("reports counts per store and the extra CA configuration", () => {
    const status = resolveTlsTrustStoreStatus({
      env: { NODE_USE_SYSTEM_CA: "1", NODE_EXTRA_CA_CERTS: "/etc/corp-root.pem" },
      execArgv: [],
      getCACertificates: fakeCertificates({
        default: 150,
        bundled: 144,
        system: 6,
        extra: 1,
      }),
    });

    expect(status).toEqual({
      systemCaEnabled: true,
      systemCaSource: "env",
      extraCaCertsConfigured: true,
      caCertificateCounts: { default: 150, bundled: 144, system: 6, extra: 1 },
    });
  });

  it("reports null counts when the runtime lacks the certificate API", () => {
    const status = resolveTlsTrustStoreStatus({
      env: {},
      execArgv: [],
      getCACertificates: undefined,
    });

    expect(status).toEqual({
      systemCaEnabled: false,
      systemCaSource: "off",
      extraCaCertsConfigured: false,
      caCertificateCounts: null,
    });
  });

  it("isolates a failing store instead of throwing", () => {
    const getCACertificates = (type: CaCertificateTypeT): string[] => {
      if (type === "system") {
        throw new Error("store unavailable");
      }
      return ["PEM"];
    };

    const status = resolveTlsTrustStoreStatus({ env: {}, execArgv: [], getCACertificates });

    expect(status.caCertificateCounts).toEqual({
      default: 1,
      bundled: 1,
      system: null,
      extra: 1,
    });
  });

  it("ignores a whitespace-only NODE_EXTRA_CA_CERTS", () => {
    const status = resolveTlsTrustStoreStatus({
      env: { NODE_EXTRA_CA_CERTS: "   " },
      execArgv: [],
      getCACertificates: undefined,
    });

    expect(status.extraCaCertsConfigured).toBe(false);
  });

  it("reads the real runtime when no dependencies are injected", () => {
    const status = resolveTlsTrustStoreStatus();

    expect(typeof status.systemCaEnabled).toBe("boolean");
    if (status.caCertificateCounts !== null) {
      expect(status.caCertificateCounts.bundled).toBeGreaterThan(0);
    }
  });
});
