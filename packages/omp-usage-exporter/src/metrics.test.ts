import { describe, it, expect } from "vitest";
import { createAllMetrics, sanitizeLabel, updateLlmMetricsFromAggregates } from "./metrics.js";
import type { AggregatedMetrics } from "./protocol.js";

describe("sanitizeLabel", () => {
  it("replaces invalid characters", () => {
    expect(sanitizeLabel("provider/model")).toBe("provider_model");
    expect(sanitizeLabel("model@1.0")).toBe("model_1_0");
    expect(sanitizeLabel("normal-model")).toBe("normal_model");
  });
  it("truncates long labels", () => {
    const long = "a".repeat(300);
    expect(sanitizeLabel(long)).toHaveLength(256);
  });

  it("trims leading/trailing underscores", () => {
    expect(sanitizeLabel("_test_")).toBe("test");
    expect(sanitizeLabel("__test__")).toBe("test");
  });
});

describe("createAllMetrics", () => {
  it("creates registry with default metrics", () => {
    const { registry, llm, operational } = createAllMetrics(1000);
    expect(registry).toBeDefined();
    expect(llm.tokensTotal).toBeDefined();
    expect(llm.reasoningTokensTotal).toBeDefined();
    expect(llm.requestsTotal).toBeDefined();
    expect(llm.reportedCostUsdTotal).toBeDefined();
    expect(llm.usageMissingTotal).toBeDefined();
    expect(operational.importErrorsTotal).toBeDefined();
    expect(operational.invalidRecordsTotal).toBeDefined();
    expect(operational.lastImportTimestamp).toBeDefined();
    expect(operational.labelCardinalityGauge).toBeDefined();
  });
});

describe("updateLlmMetricsFromAggregates", () => {
  it("updates metrics from aggregates", () => {
    const { llm } = createAllMetrics(1000);
    const aggregates: AggregatedMetrics[] = [
      { provider: "openrouter", model: "openrouter/free", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 50, requestsSuccess: 10, requestsError: 1, reportedCostUsd: 0.01, usageMissing: 0 },
      { provider: "anthropic", model: "claude-3-opus", inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 100, cacheWriteTokens: 50, reasoningTokens: 200, requestsSuccess: 5, requestsError: 0, reportedCostUsd: 0.05, usageMissing: 0 },
    ];

    const cardinality = updateLlmMetricsFromAggregates(llm, aggregates, 1000);
    expect(cardinality).toBe(2);
  });

  it("aggregates excess into _other when over cardinality limit", () => {
    const { llm } = createAllMetrics(2);
    const aggregates: AggregatedMetrics[] = [
      { provider: "p1", model: "m1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requestsSuccess: 1, requestsError: 0, reportedCostUsd: 0, usageMissing: 0 },
      { provider: "p2", model: "m2", inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requestsSuccess: 1, requestsError: 0, reportedCostUsd: 0, usageMissing: 0 },
      { provider: "p3", model: "m3", inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requestsSuccess: 1, requestsError: 0, reportedCostUsd: 0, usageMissing: 0 },
    ];

    const cardinality = updateLlmMetricsFromAggregates(llm, aggregates, 2);
    expect(cardinality).toBe(2);
  });
});