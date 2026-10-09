import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ExporterServer } from "./server.js";
import { createAllMetrics } from "./metrics.js";

describe("ExporterServer", () => {
  let server: ExporterServer;
  const port = 19464 + Math.floor(Math.random() * 1000);
  const listen = `127.0.0.1:${port}`;

  beforeEach(() => {
    const { registry, operational } = createAllMetrics(1000);
    server = new ExporterServer(registry, operational, listen);
  });

  afterEach(async () => {
    await server.stop();
  });

  it("starts and stops", async () => {
    console.log("Starting server on", listen);
    await server.start();
    console.log("Server started, address:", server.address());
    expect(server.address()).toBe(listen);
    // Check if server is actually listening
    const net = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
      socket.setTimeout(1000, () => reject(new Error("Connection timeout")));
    });
    console.log("Server is accepting connections");
    await server.stop();
    console.log("Server stopped");
  });

  it("serves /metrics", async () => {
    await server.start();
    try {
      const response = await fetch(`http://${listen}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      const text = await response.text();
      expect(text).toContain("omp_usage_");
    } catch (e) {
      console.error("Fetch error:", e);
      throw e;
    }
  });
  it("serves /healthz", async () => {
    await server.start();
    const response = await fetch(`http://${listen}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const json = await response.json();
    expect(json.status).toBe("ok");
    expect(json.timestamp).toBeDefined();
  });

  it("returns 404 for unknown paths", async () => {
    await server.start();
    const response = await fetch(`http://${listen}/unknown`);
    expect(response.status).toBe(404);
  });
});