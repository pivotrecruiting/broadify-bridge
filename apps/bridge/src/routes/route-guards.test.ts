import { getAuthFailure, enforceLocalOrToken } from "./route-guards.js";

const makeRequest = (
  ip: string,
  headers: Record<string, string | string[]> = {}
) =>
  ({
    ip,
    headers,
  }) as any;

const makeReply = () => ({
  code: jest.fn().mockReturnThis(),
  send: jest.fn(),
});

describe("getAuthFailure", () => {
  const previousToken = process.env.BRIDGE_API_TOKEN;

  afterEach(() => {
    process.env.BRIDGE_API_TOKEN = previousToken;
  });

  it("allows loopback requests without token", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const failure = getAuthFailure(makeRequest("127.0.0.1"));
    expect(failure).toBeNull();
  });

  it("rejects non-local requests when token is missing", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const failure = getAuthFailure(makeRequest("192.168.1.20"));
    expect(failure).toEqual({
      status: 403,
      message: "Local-only endpoint",
    });
  });

  it("allows valid bearer token for non-local request", () => {
    process.env.BRIDGE_API_TOKEN = "secret";
    const failure = getAuthFailure(
      makeRequest("192.168.1.20", { authorization: "Bearer secret" }),
    );
    expect(failure).toBeNull();
  });

  it("rejects invalid bearer token for non-local request", () => {
    process.env.BRIDGE_API_TOKEN = "secret";
    const failure = getAuthFailure(
      makeRequest("192.168.1.20", { authorization: "Bearer nope" }),
    );
    expect(failure).toEqual({
      status: 401,
      message: "Unauthorized",
    });
  });

  it("allows valid x-bridge-auth token for non-local request", () => {
    process.env.BRIDGE_API_TOKEN = "secret";
    const failure = getAuthFailure(
      makeRequest("192.168.1.20", { "x-bridge-auth": "secret" }),
    );
    expect(failure).toBeNull();
  });

  it("normalizes IPv4-mapped IPv6 loopback", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const failure = getAuthFailure(makeRequest("::ffff:127.0.0.1"));
    expect(failure).toBeNull();
  });

  it("extracts token from array authorization header", () => {
    process.env.BRIDGE_API_TOKEN = "secret";
    const failure = getAuthFailure(
      makeRequest("192.168.1.1", { authorization: ["Bearer secret"] })
    );
    expect(failure).toBeNull();
  });

  it("extracts token from bearer prefix", () => {
    process.env.BRIDGE_API_TOKEN = "secret";
    const failure = getAuthFailure(
      makeRequest("10.0.0.1", { authorization: "  Bearer   secret  " })
    );
    expect(failure).toBeNull();
  });

  it("rejects loopback requests from a foreign origin", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const failure = getAuthFailure(
      makeRequest("127.0.0.1", {
        origin: "https://evil.example",
        host: "127.0.0.1:8787",
      }),
    );
    expect(failure).toEqual({ status: 403, message: "Origin not allowed" });
  });

  it("allows loopback requests from an allowlisted origin", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const failure = getAuthFailure(
      makeRequest("127.0.0.1", {
        origin: "https://app.broadify.de",
        host: "localhost:8787",
      }),
    );
    expect(failure).toBeNull();
  });

  it("allows loopback requests without an origin header (native clients)", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const failure = getAuthFailure(
      makeRequest("127.0.0.1", { host: "127.0.0.1:8787" }),
    );
    expect(failure).toBeNull();
  });

  it("allows extra origins from BRIDGE_ALLOWED_ORIGINS", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const previous = process.env.BRIDGE_ALLOWED_ORIGINS;
    process.env.BRIDGE_ALLOWED_ORIGINS = "http://localhost:3555";
    try {
      const failure = getAuthFailure(
        makeRequest("127.0.0.1", {
          origin: "http://localhost:3555",
          host: "localhost:8787",
        }),
      );
      expect(failure).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.BRIDGE_ALLOWED_ORIGINS;
      } else {
        process.env.BRIDGE_ALLOWED_ORIGINS = previous;
      }
    }
  });

  it("rejects loopback requests with a foreign Host header (DNS rebinding)", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const failure = getAuthFailure(
      makeRequest("127.0.0.1", { host: "attacker.example:8787" }),
    );
    expect(failure).toEqual({ status: 403, message: "Host not allowed" });
  });

  it("accepts local Host headers including bracketed IPv6", () => {
    delete process.env.BRIDGE_API_TOKEN;
    for (const host of ["localhost:8787", "127.0.0.1", "[::1]:8787"]) {
      expect(getAuthFailure(makeRequest("127.0.0.1", { host }))).toBeNull();
    }
  });
});

describe("enforceLocalOrToken", () => {
  const previousToken = process.env.BRIDGE_API_TOKEN;

  afterEach(() => {
    process.env.BRIDGE_API_TOKEN = previousToken;
  });

  it("returns true for loopback request", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const reply = makeReply();
    const result = enforceLocalOrToken(
      makeRequest("127.0.0.1"),
      reply as any
    );
    expect(result).toBe(true);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns true when token valid", () => {
    process.env.BRIDGE_API_TOKEN = "secret";
    const reply = makeReply();
    const result = enforceLocalOrToken(
      makeRequest("192.168.1.1", { authorization: "Bearer secret" }),
      reply as any
    );
    expect(result).toBe(true);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it("returns false and sends 403 when token missing for non-local", () => {
    delete process.env.BRIDGE_API_TOKEN;
    const reply = makeReply();
    const result = enforceLocalOrToken(
      makeRequest("192.168.1.1"),
      reply as any
    );
    expect(result).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: "Local-only endpoint",
    });
  });

  it("returns false and sends 401 when token invalid for non-local", () => {
    process.env.BRIDGE_API_TOKEN = "secret";
    const reply = makeReply();
    const result = enforceLocalOrToken(
      makeRequest("192.168.1.1", { authorization: "Bearer wrong" }),
      reply as any
    );
    expect(result).toBe(false);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: "Unauthorized",
    });
  });
});
