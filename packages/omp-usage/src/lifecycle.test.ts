import { describe, it, expect, beforeEach } from "vitest";
import { initializePlugin } from "./lifecycle.js";
import type { OmpApi, PluginConfig } from "./types.js";
describe("initializePlugin", () => {
  let mockApi: OmpApi;
  let messageEndHandler: ((event: { message: unknown }) => void) | null;
  let shutdownHandler: (() => void | Promise<void>) | null;
  let config: Partial<PluginConfig>;

  beforeEach(() => {
    messageEndHandler = null;
    shutdownHandler = null;
    config = { eventsDir: "/tmp/test-events", maxQueueSize: 100 };

    mockApi = {
      on: (event, handler) => {
        if (event === "message_end") {
          messageEndHandler = handler as (event: { message: unknown }) => void;
        } else if (event === "shutdown") {
          shutdownHandler = handler as () => void | Promise<void>;
        }
      },
    };
  });

  it("registers message_end and shutdown handlers", () => {
    const _cleanup = initializePlugin(mockApi, config);
    expect(messageEndHandler).not.toBeNull();
    expect(shutdownHandler).not.toBeNull();
    expect(typeof _cleanup).toBe("function");
  });

  it("calls shutdown handler on shutdown event", async () => {
    const _cleanup = initializePlugin(mockApi, config);
    await shutdownHandler!();
    // Should not throw
  });

  it("cleanup function calls shutdown", async () => {
    const _cleanup = initializePlugin(mockApi, config);
    await _cleanup();
    // Should not throw
  });

  it("ignores non-assistant messages", async () => {
    const cleanup = initializePlugin(mockApi, config);
    const userMessage = { role: "user", content: "hello" };
    messageEndHandler!({ message: userMessage });
    await cleanup();
  });

  it("handles message with null fields", async () => {
    const cleanup = initializePlugin(mockApi, config);
    const message = {
      role: "assistant",
      provider: null,
      model: null,
      api: null,
      stopReason: "error",
      usage: null,
    };
    messageEndHandler!({ message });
    await cleanup();
  });
});