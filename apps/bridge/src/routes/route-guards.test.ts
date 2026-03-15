import { getAuthFailure } from "./route-guards.js";

const makeRequest = (ip: string, headers: Record<string, string> = {}) =>
  ({
    ip,
    headers,
  }) as any;

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
});
