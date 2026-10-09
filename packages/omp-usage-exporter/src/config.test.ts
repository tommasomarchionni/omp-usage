import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveConfig, validateConfig, parseListen } from "./config.js";
describe("parseListen", () => {
  it("parses host:port", () => {
    expect(parseListen("127.0.0.1:9464")).toEqual({ host: "127.0.0.1", port: 9464 });
    expect(parseListen("0.0.0.0:8080")).toEqual({ host: "0.0.0.0", port: 8080 });
  });
});

describe("validateConfig", () => {
  const validConfig = {
    eventsDir: "/tmp/events",
    dbPath: "/tmp/db.sqlite",
    listen: "127.0.0.1:9464",
    maxLineLength: 1048576,
    logLevel: "info" as const,
    maxLabelCardinality: 1000,
  };

  it("accepts valid config", () => {
    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it("rejects empty eventsDir", () => {
    expect(() => validateConfig({ ...validConfig, eventsDir: "" })).toThrow("eventsDir is required");
  });

  it("rejects empty dbPath", () => {
    expect(() => validateConfig({ ...validConfig, dbPath: "" })).toThrow("dbPath is required");
  });

  it("rejects invalid maxLineLength", () => {
    expect(() => validateConfig({ ...validConfig, maxLineLength: 0 })).toThrow("maxLineLength must be positive");
    expect(() => validateConfig({ ...validConfig, maxLineLength: -1 })).toThrow("maxLineLength must be positive");
  });

  it("rejects invalid maxLabelCardinality", () => {
    expect(() => validateConfig({ ...validConfig, maxLabelCardinality: 0 })).toThrow("maxLabelCardinality must be positive");
  });

  it("rejects invalid listen format", () => {
    expect(() => validateConfig({ ...validConfig, listen: "invalid" })).toThrow("listen must be in format host:port");
    expect(() => validateConfig({ ...validConfig, listen: "localhost" })).toThrow("listen must be in format host:port");
  });

  it("rejects invalid port", () => {
    expect(() => validateConfig({ ...validConfig, listen: "127.0.0.1:0" })).toThrow("port must be between 1 and 65535");
    expect(() => validateConfig({ ...validConfig, listen: "127.0.0.1:65536" })).toThrow("port must be between 1 and 65535");
    expect(() => validateConfig({ ...validConfig, listen: "127.0.0.1:abc" })).toThrow("port must be between 1 and 65535");
  });
});

describe("resolveConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses defaults when no flags or env", () => {
    const config = resolveConfig({});
    expect(config.listen).toBe("127.0.0.1:9464");
    expect(config.maxLineLength).toBe(1048576);
    expect(config.logLevel).toBe("info");
    expect(config.maxLabelCardinality).toBe(1000);
    expect(config.eventsDir).toContain(".local/state/omp-usage/events");
    expect(config.dbPath).toContain(".local/state/omp-usage/exporter.db");
  });

  it("uses flags over env over defaults", () => {
    vi.stubEnv("OMP_USAGE_LISTEN", "0.0.0.0:8080");
    const config = resolveConfig({ listen: "127.0.0.1:9999" });
    expect(config.listen).toBe("127.0.0.1:9999");
  });

  it("uses env over defaults", () => {
    vi.stubEnv("OMP_USAGE_LISTEN", "0.0.0.0:8080");
    const config = resolveConfig({});
    expect(config.listen).toBe("0.0.0.0:8080");
  });

  it("expands tilde in paths", () => {
    const config = resolveConfig({ eventsDir: "~/custom/events" });
    expect(config.eventsDir).not.toContain("~");
    expect(config.eventsDir).toContain("custom/events");
  });
});