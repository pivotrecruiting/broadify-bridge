import Fastify from "fastify";
import { registerLogsRoute } from "./logs.js";

const mockReadFile = jest.fn().mockResolvedValue("line1\nline2\nline3\nline4\nline5");
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
const mockGetLogPath = jest.fn().mockReturnValue("/tmp/bridge.log");
const mockEnforceLocalOrToken = jest.fn().mockReturnValue(true);

describe("registerLogsRoute integration", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockEnforceLocalOrToken.mockReturnValue(true);
    mockReadFile.mockResolvedValue("line1\nline2\nline3\nline4\nline5");
    app = Fastify();
    await app.register(registerLogsRoute, {
      readFile: mockReadFile as never,
      writeFile: mockWriteFile as never,
      getLogPath: mockGetLogPath,
      enforceLocalOrToken: mockEnforceLocalOrToken as never,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /logs returns tail lines and applies filter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/logs?lines=3&filter=line3",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      scope: "bridge",
      lines: 1,
      content: "line3",
    });
    expect(mockReadFile).toHaveBeenCalledWith("/tmp/bridge.log", "utf-8");
  });

  it("GET /logs returns last N lines (tail behavior)", async () => {
    mockReadFile.mockResolvedValue("a\nb\nc\nd\ne\nf");

    const response = await app.inject({
      method: "GET",
      url: "/logs?lines=2",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.lines).toBe(2);
    expect(body.content).toBe("e\nf");
  });

  it("GET /logs clamps lines between 1 and 5000", async () => {
    await app.inject({ method: "GET", url: "/logs?lines=0" });
    expect(mockReadFile).toHaveBeenCalled();
    const body = (await app.inject({ method: "GET", url: "/logs?lines=0" })).json();
    expect(body.lines).toBeLessThanOrEqual(5000);
  });

  it("GET /logs returns 500 when readFile fails", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    const response = await app.inject({
      method: "GET",
      url: "/logs",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      scope: "bridge",
      error: "ENOENT",
      content: "",
    });
  });

  it("POST /logs/clear clears log file", async () => {
    mockReadFile.mockResolvedValue("content");

    const response = await app.inject({
      method: "POST",
      url: "/logs/clear",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ scope: "bridge", cleared: true });
    expect(mockWriteFile).toHaveBeenCalledWith("/tmp/bridge.log", "");
  });

  it("POST /logs/clear returns cleared true when file is ENOENT", async () => {
    mockReadFile.mockRejectedValue({ code: "ENOENT" });

    const response = await app.inject({
      method: "POST",
      url: "/logs/clear",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ scope: "bridge", cleared: true });
  });

  it("POST /logs/clear returns 500 on other write errors", async () => {
    mockReadFile.mockResolvedValue("x");
    mockWriteFile.mockRejectedValue(new Error("EACCES"));

    const response = await app.inject({
      method: "POST",
      url: "/logs/clear",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      scope: "bridge",
      cleared: false,
      error: "EACCES",
    });
  });
});
