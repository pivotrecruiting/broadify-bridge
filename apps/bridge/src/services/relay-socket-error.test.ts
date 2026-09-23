import {
  classifyRelaySocketError,
  describeRelaySocketError,
} from "./relay-socket-error.js";

const codedError = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

describe("classifyRelaySocketError", () => {
  it("classifies untrusted-chain verification codes", () => {
    for (const code of [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    ]) {
      expect(classifyRelaySocketError(codedError("x", code))).toEqual({
        kind: "tls_untrusted_chain",
        code,
        message: "x",
      });
    }
  });

  it("classifies invalid-certificate verification codes", () => {
    for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      expect(classifyRelaySocketError(codedError("x", code))).toEqual({
        kind: "tls_certificate_invalid",
        code,
        message: "x",
      });
    }
  });

  it("treats other codes, missing codes and non-errors as other", () => {
    expect(classifyRelaySocketError(codedError("refused", "ECONNREFUSED"))).toEqual({
      kind: "other",
      code: "ECONNREFUSED",
      message: "refused",
    });
    expect(classifyRelaySocketError(new Error("plain"))).toEqual({
      kind: "other",
      code: null,
      message: "plain",
    });
    expect(classifyRelaySocketError("string failure")).toEqual({
      kind: "other",
      code: null,
      message: "string failure",
    });
    expect(
      classifyRelaySocketError(Object.assign(new Error("numeric"), { code: 42 }))
    ).toEqual({ kind: "other", code: null, message: "numeric" });
  });
});

describe("describeRelaySocketError", () => {
  it("keeps the plain message for errors without a code", () => {
    expect(describeRelaySocketError(new Error("network error"))).toBe("network error");
  });

  it("appends the code for non-TLS errors without a hint", () => {
    expect(
      describeRelaySocketError(codedError("getaddrinfo ENOTFOUND relay", "ENOTFOUND"))
    ).toBe("getaddrinfo ENOTFOUND relay (code: ENOTFOUND)");
  });

  it("explains untrusted chains and reports the system trust store state", () => {
    const error = codedError(
      "self signed certificate in certificate chain",
      "SELF_SIGNED_CERT_IN_CHAIN"
    );

    const disabled = describeRelaySocketError(error, { env: {}, execArgv: [] });
    expect(disabled).toContain(
      "self signed certificate in certificate chain (code: SELF_SIGNED_CERT_IN_CHAIN)"
    );
    expect(disabled).toContain("TLS-inspecting proxy");
    expect(disabled).toContain("System trust store: disabled");
    expect(disabled).toContain("NODE_EXTRA_CA_CERTS");

    const enabled = describeRelaySocketError(error, {
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
    });
    expect(enabled).toContain("System trust store: enabled");
  });

  it("explains invalid certificates without a trust-store hint", () => {
    const text = describeRelaySocketError(
      codedError("certificate has expired", "CERT_HAS_EXPIRED"),
      { env: {}, execArgv: [] }
    );

    expect(text).toContain("certificate has expired (code: CERT_HAS_EXPIRED)");
    expect(text).toContain("system clock");
    expect(text).not.toContain("System trust store");
  });

  it("never copies environment values into the message", () => {
    const text = describeRelaySocketError(
      codedError("x", "SELF_SIGNED_CERT_IN_CHAIN"),
      { env: { NODE_EXTRA_CA_CERTS: "/Users/secret/corp.pem" }, execArgv: [] }
    );

    expect(text).not.toContain("/Users/secret");
  });
});
