import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateClientReport } from "../client-report.ts";

function trial(client: "copilot" | "claude", stimulus = "hello", wallTimeMs = client === "copilot" ? 617306 : 818015) {
  const claude = client === "claude";
  return {
    type: "trial-result", status: "success", stimulus, durationMs: wallTimeMs + 60000,
    gradeResult: {
      passed: claude, score: claude ? 1 : 0.75, details: [
        { name: "outcome", passed: true, score: 1, evidence: "Remote invocation verified.", metadata: { greeting: "Hello, world!" } },
        { name: "prompt", passed: claude, score: claude ? 1 : 0, evidence: claude ? "Followed scope." : "Submitted prohibited evaluation generation." },
      ],
    },
    trajectory: {
      stimulus: { name: stimulus }, metadata: { executor: claude ? "claude-cli" : "integration-test-agent-runner", model: "same-model" },
      metrics: {
        wallTimeMs, toolCallCount: claude ? 79 : 47, turnCount: claude ? 1 : 45,
        tokenUsage: {
          inputTokens: claude ? 650 : 2665480, outputTokens: claude ? 22180 : 12563,
          totalTokens: claude ? 22830 : 2678043, cacheReadTokens: claude ? 4692471 : 2590250,
          cacheWriteTokens: claude ? 87096 : 75140, callCount: claude ? 2 : 45,
          byModel: claude ? { "same-model": {}, "auxiliary-model": {} } : { "same-model": {} },
        },
      },
    },
  };
}

describe("cross-client reports", () => {
  let root: string;
  async function writeRows(client: string, rows: unknown[]) {
    await writeFile(path.join(root, `${client}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  async function writeManifest(overrides: Record<string, unknown> = {}) {
    await writeFile(path.join(root, "comparison-run.json"), JSON.stringify({
      status: "completed", runs: 1, stimuli: ["hello"], judgeModel: "judge-model", skipJudge: false,
      results: { copilot: "copilot.jsonl", claude: "claude.jsonl" }, ...overrides,
    }));
  }
  async function report() {
    const markdown = await readFile(await generateClientReport(root), "utf8");
    const json = JSON.parse(await readFile(path.join(root, "comparison-report.json"), "utf8"));
    return { markdown, json };
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "client-report-test-"));
    await writeManifest();
    await writeRows("copilot", [trial("copilot"), { type: "run-summary", passed: false }]);
    await writeRows("claude", [trial("claude")]);
    await writeFile(path.join(root, "comparison.jsonl"), JSON.stringify({
      type: "comparison", baseline: "results", treatment: "results",
      stimuli: [{ stimulusName: "hello", trials: [{
        winner: "treatment", magnitude: "slightly-better", evidence: "Both deployed; treatment followed scope.",
        criteria: [{ evidence: "Position-swap unverified: reverse judgment did not include this criterion. Defaulting to tie." }],
      }] }],
    }));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  test("reports all six dimensions using actual quality and executor time, not grading time", async () => {
    const original = await readFile(path.join(root, "copilot.jsonl"), "utf8");
    const { markdown, json } = await report();
    expect(json.complete).toBe(true);
    expect(json.clients).toHaveLength(2);
    expect(json.clients[0].quality.mean).toBe(0.75);
    expect(json.clients[0].passed).toBe(0);
    expect(json.clients[0].activeTimeMs.mean).toBe(617306);
    expect(json.clients[1].activeTimeMs.mean).toBe(818015);
    expect(json.clients[0].source).toBe("copilot.jsonl");
    expect(JSON.stringify(json)).not.toContain(root);
    expect(markdown).toContain("| Active completion time: mean (range) | 617.31 s | 818.02 s |");
    expect(markdown).toContain("| Tool calls: mean (range) | 47 | 79 |");
    expect(markdown).toContain("| Turns: native mean (not equivalent) | 45 | 1 |");
    expect(markdown).toContain("| Result quality: mean score (range) | 75% | 100% |");
    expect(markdown).toContain("## Overall assessment");
    expect(markdown).toContain("Submitted prohibited evaluation generation.");
    expect(markdown).toContain("Observed greeting: Hello, world!");
    expect(markdown).toContain("[Original results and trajectories](copilot.jsonl)");
    expect(await readFile(path.join(root, "copilot.jsonl"), "utf8")).toBe(original);
  });

  test("keeps cache counters separate and disclaims native token and turn comparisons", async () => {
    const { markdown, json } = await report();
    expect(json.clients[1].tokens.totalTokens.mean).toBe(22830);
    expect(json.clients[1].tokens.cacheReadTokens.mean).toBe(4692471);
    expect(markdown).toContain("| Tokens: raw total mean (not equivalent) | 2,678,043 | 22,830 |");
    expect(markdown).toContain("auxiliary-model");
    expect(markdown).toContain("not directly comparable");
    expect(markdown).not.toMatch(/\d+% (fewer tokens|token savings)/);
    expect(json.assessment.join(" ")).toContain("No combined efficiency score");
  });

  test("labels an existing judge preference and exposes position-swap uncertainty", async () => {
    const { json, markdown } = await report();
    expect(json.judgments[0]).toMatchObject({ preferredClient: "claude", unverified: true });
    expect(markdown).toContain("Baseline = Copilot CLI; treatment = Claude Code.");
    expect(markdown).toContain("per-criterion position-swap checks were unverified");
    expect(markdown).toContain("Only one trial");
  });

  test("aggregates repeated trials with counts, ranges, and per-trial evidence", async () => {
    await writeManifest({ runs: 2 });
    await writeRows("copilot", [trial("copilot", "hello", 1000), trial("copilot", "hello", 3000)]);
    await writeRows("claude", [trial("claude", "hello", 2000), trial("claude", "hello", 6000)]);
    const { markdown, json } = await report();
    expect(json.clients[0].activeTimeMs).toEqual({ count: 2, total: 4000, mean: 2000, min: 1000, max: 3000 });
    expect(json.clients[1].toolCalls.total).toBe(158);
    expect(markdown).toContain("| Active completion time: mean (range) | 2 s (1 s-3 s) | 4 s (2 s-6 s) |");
    expect(markdown).toContain("hello (result line 2)");
    expect(json.complete).toBe(true);
  });

  test("does not infer absent measurements as zero or use durationMs for active time", async () => {
    await writeRows("claude", [{
      type: "trial-result", status: "success", stimulus: "hello", durationMs: 123456,
      trajectory: { stimulus: { name: "hello" } },
    }]);
    const { json, markdown } = await report();
    expect(json.clients[1].activeTimeMs.mean).toBeNull();
    expect(json.clients[1].quality.mean).toBeNull();
    expect(json.clients[1].tokens.totalTokens.mean).toBeNull();
    expect(markdown).toContain("N/A is not zero");
    expect(markdown).toContain("0/0 graded; 1 ungraded");
    expect(json.assessment.join(" ")).not.toContain("has the highest");
  });

  test("counts recorded tool and turn events while keeping absent usage unknown", async () => {
    await writeRows("claude", [{
      type: "trial-result", status: "success", stimulus: "hello",
      trajectory: { events: [{ type: "tool_call" }, { type: "tool_result" }, { type: "turn_end" }] },
    }]);
    const { json } = await report();
    expect(json.clients[1].toolCalls.mean).toBe(1);
    expect(json.clients[1].turns.mean).toBe(1);
    expect(json.clients[1].tokens.totalTokens.mean).toBeNull();
  });

  test("does not treat empty Vally token metrics as observed zero usage", async () => {
    const row = trial("claude");
    row.trajectory.metrics.tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, callCount: 0, byModel: { "same-model": {} } };
    await writeRows("claude", [row]);
    expect((await report()).json.clients[1].tokens.totalTokens.mean).toBeNull();
  });

  test("shows partial metric coverage instead of presenting a subtotal as complete", async () => {
    await writeManifest({ runs: 2 });
    await writeRows("copilot", [trial("copilot"), trial("copilot")]);
    await writeRows("claude", [trial("claude"), { type: "trial-result", status: "error", stimulus: "hello", error: { message: "Timed out" } }]);
    const { json, markdown } = await report();
    expect(json.clients[1].executionErrors).toBe(1);
    expect(markdown).toContain("[1/2 recorded]");
    expect(markdown).toContain("Timed out");
    expect(json.assessment.join(" ")).not.toContain("has the lowest");
  });

  test("does not rank unmatched stimuli or missing clients", async () => {
    await writeRows("claude", [trial("claude", "different prompt")]);
    let output = await report();
    expect(output.json.complete).toBe(false);
    expect(output.markdown).toContain("Incomplete or unequal trial coverage");
    await writeManifest({ status: "failed", results: { copilot: "copilot.jsonl" }, error: "Claude launch failed" });
    output = await report();
    expect(output.json.clients[1].trials).toEqual([]);
    expect(output.markdown).toContain("Claude launch failed");
    expect(output.markdown).toContain("No result artifact was recorded.");
  });

  test("detects expected stimuli missing from both clients", async () => {
    await writeManifest({ stimuli: ["hello", "missing"] });
    expect((await report()).json.complete).toBe(false);
  });

  test("does not rank a failed run even when both result files exist", async () => {
    await writeManifest({ status: "failed", error: "Eval inputs changed during comparison." });
    const { json, markdown } = await report();
    expect(markdown).toContain("Eval inputs changed during comparison.");
    expect(json.assessment.join(" ")).not.toContain("has the highest");
    expect(json.assessment.join(" ")).not.toContain("has the lowest");
  });

  test("distinguishes a skipped judge from a missing judge artifact", async () => {
    await writeManifest({ skipJudge: true });
    expect((await report()).json.judgeStatus).toBe("skipped");
    await writeManifest();
    await rm(path.join(root, "comparison.jsonl"));
    const { markdown, json } = await report();
    expect(json.judgeStatus).toBe("unavailable");
    expect(markdown).toContain("Pairwise judgment is unavailable");
  });

  test("escapes grader text and rejects corrupted result and judge artifacts", async () => {
    const row = trial("claude", "hello");
    row.gradeResult.details[0].evidence = "<script> | break\nnext";
    await writeRows("claude", [row]);
    expect((await report()).markdown).toContain("&lt;script&gt; \\| break<br>next");
    await writeFile(path.join(root, "comparison.jsonl"), "not-json");
    await expect(generateClientReport(root)).rejects.toThrow("Invalid JSONL");
    await writeFile(path.join(root, "copilot.jsonl"), "{bad-json");
    await expect(generateClientReport(root)).rejects.toThrow("copilot.jsonl:1");
  });

  test("fails explicitly for missing result files and out-of-range quality scores", async () => {
    const row = trial("copilot");
    row.gradeResult.score = 2;
    await writeRows("copilot", [row]);
    await expect(generateClientReport(root)).rejects.toThrow("outside [0, 1]");
    await rm(path.join(root, "copilot.jsonl"));
    await expect(generateClientReport(root)).rejects.toThrow("ENOENT");
  });
});
