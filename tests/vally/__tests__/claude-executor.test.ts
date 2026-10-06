import type { ExecutorOptions, Stimulus, Trajectory } from "@microsoft/vally";
import { computeMetrics } from "@microsoft/vally";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClaudeIntegrationExecutor, loadClaudeExecutor } from "../claude-executor.ts";
import { listPlugins } from "../../utils/skill-loader.ts";

describe("ClaudeIntegrationExecutor", () => {
  let root: string;
  let stimulus: Stimulus;
  let options: ExecutorOptions;
  let trajectory: Trajectory;
  const execute = vi.fn<(stimulus: Stimulus, options: ExecutorOptions) => Promise<Trajectory>>();
  const shutdown = vi.fn<() => Promise<void>>();
  const construct = vi.fn();
  class FakeClaude {
    name = "claude-cli";
    execute = execute;
    shutdown = shutdown;
    constructor(config: { claudePath?: string; extraArgs?: string[] }) {
      construct(config);
    }
  }
  const adapter = new ClaudeIntegrationExecutor(FakeClaude);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "claude-executor-test-"));
    const output = path.join(root, "output");
    await mkdir(path.join(output, "hooks"), { recursive: true });
    for (const name of ["azure-ai", "azure-other"]) {
      const dir = path.join(output, "azure-skills", "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\nInstructions.`);
    }
    vi.stubEnv("VALLY_PLUGIN_OUTPUT_ROOT", output);
    vi.stubEnv("NO_SKILLS", "false");
    vi.stubEnv("MODEL_OVERRIDE", "");
    vi.stubEnv("CLAUDE_CLI_PATH", "");
    vi.stubEnv("VALLY_FAIR_COMPARISON", "true");
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "auth"));
    stimulus = { name: "routing", prompt: "Help with search", tags: { skill: "azure-ai" } };
    options = { workDir: path.join(root, "workspace"), timeout: 1000, model: "claude-sonnet-5" };
    await mkdir(options.workDir);
    await writeFile(path.join(options.workDir, "fixture.txt"), "preserved");
    trajectory = {
      id: "trial",
      stimulus,
      workDir: options.workDir,
      output: "done",
      events: [{
        type: "tool_call",
        data: { toolCallId: "skill-1", toolName: "skill", arguments: { skill: "azure-ai" } },
      }],
      metadata: {
        startedAt: new Date(), completedAt: new Date(), model: "sonnet",
        executor: "claude-cli", skillsLoaded: [], sessionID: "session",
      },
      metrics: { ...computeMetrics([]), wallTimeMs: 123 },
    };
    execute.mockResolvedValue(trajectory);
    shutdown.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  test("stages exact workspace skills, preserves fixtures, and emits grader-compatible activations", async () => {
    const result = await adapter.execute(stimulus, options);
    expect(await readFile(path.join(options.workDir, ".claude", "skills", "azure-ai", "SKILL.md"), "utf8")).toContain("Instructions.");
    await expect(readFile(path.join(options.workDir, ".claude", "skills", "azure-other", "SKILL.md"))).rejects.toThrow();
    expect(await readFile(path.join(options.workDir, "fixture.txt"), "utf8")).toBe("preserved");
    expect(listPlugins().map(plugin => plugin.dirname)).toEqual(["azure-skills"]);
    expect(result.metadata.skillsLoaded).toEqual(["azure-ai"]);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "skill_activation", data: expect.objectContaining({ name: "azure-ai" }),
    }));
    expect(result.metrics.wallTimeMs).toBe(123);
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({
      extraArgs: ["--setting-sources", "project", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"],
    }));
    expect(shutdown).toHaveBeenCalledOnce();
  });

  test("forwards multi-turn, timeout, environment and explicit MCP servers", async () => {
    stimulus.turns = ["First turn", "Second turn"];
    options.env = { TEST_VAR: "value" };
    const custom = { type: "stdio", command: "node", args: ["server.js"] } as const;
    options.mcpServers = { custom: { ...custom, args: [...custom.args] } };
    await adapter.execute(stimulus, options);
    expect(execute).toHaveBeenCalledWith(stimulus, expect.objectContaining({
      timeout: 1000, model: "claude-sonnet-5",
      env: expect.objectContaining({ TEST_VAR: "value" }),
      mcpServers: { custom },
    }));
  });

  test("uses an explicit native Claude path when configured", async () => {
    vi.stubEnv("CLAUDE_CLI_PATH", path.join(root, "claude.exe"));
    await adapter.execute(stimulus, options);
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({ claudePath: path.join(root, "claude.exe") }));
  });

  test.each(["append", "replace"])("maps %s system prompts", async mode => {
    stimulus.tags = { skill: "azure-ai", systemPrompt: JSON.stringify({ mode, content: "Be concise." }) };
    await adapter.execute(stimulus, options);
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({
      extraArgs: [
        mode === "replace" ? "--system-prompt" : "--append-system-prompt",
        "Be concise.", "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
      ],
    }));
  });

  test.each<Record<string, string>>([
    { skill: "missing" },
    { skill: "azure-ai", takeScreenshot: "[]" },
    { skill: "azure-ai", systemPrompt: "{}" },
    { skill: "azure-ai", systemPrompt: "{\"mode\":\"custom\",\"content\":\"test\"}" },
    { skill: "azure-ai", systemPrompt: "{\"content\":\"test\",\"sections\":{}}" },
  ])("fails explicitly on unsupported tags or missing skills: %j", async tags => {
    stimulus.tags = tags;
    await expect(adapter.execute(stimulus, options)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  test("does not overwrite skills supplied by fixtures", async () => {
    const dir = path.join(options.workDir, ".claude", "skills", "azure-ai");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "fixture skill");
    await expect(adapter.execute(stimulus, options)).rejects.toThrow();
    expect(await readFile(path.join(dir, "SKILL.md"), "utf8")).toBe("fixture skill");
  });

  test("propagates execution failures and shuts down", async () => {
    execute.mockRejectedValueOnce(new Error("Claude failed"));
    await expect(adapter.execute(stimulus, options)).rejects.toThrow("Claude failed");
    expect(shutdown).toHaveBeenCalledOnce();
  });

  test("reports a missing upstream module with setup instructions", async () => {
    vi.stubEnv("VALLY_CLAUDE_EXECUTOR_MODULE", path.join(root, "missing.js"));
    await expect(loadClaudeExecutor()).rejects.toThrow("VALLY_CLAUDE_EXECUTOR_MODULE");
  });

  test("disables early stops and isolates ambient config", async () => {
    stimulus.tags = { skill: "azure-ai", earlyTerminate: "[]" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await adapter.execute(stimulus, options);
    expect(result.metadata.skillsLoaded).toEqual(["azure-ai"]);
    expect(execute.mock.calls[0][0].tags).not.toHaveProperty("earlyTerminate");
    expect(execute.mock.calls[0][1].mcpServers).toEqual({});
    const configDir = execute.mock.calls[0][1].env?.CLAUDE_CONFIG_DIR;
    expect(configDir).toBeTruthy();
    expect(configDir).not.toBe(process.env.CLAUDE_CONFIG_DIR);
    await expect(access(configDir!)).rejects.toThrow();
    expect(stimulus.tags.earlyTerminate).toBe("[]");
  });

  test("comparison copies only auth into its temporary config and removes it on failure", async () => {
    await mkdir(process.env.CLAUDE_CONFIG_DIR!);
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), "{\"test\":true}");
    await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), "{\"testSetting\":true}");
    let isolatedDir = "";
    execute.mockImplementationOnce(async (_stimulus, received) => {
      isolatedDir = received.env!.CLAUDE_CONFIG_DIR;
      expect(await readFile(path.join(isolatedDir, ".credentials.json"), "utf8")).toBe("{\"test\":true}");
      await expect(access(path.join(isolatedDir, "settings.json"))).rejects.toThrow();
      throw new Error("agent failed");
    });
    await expect(adapter.execute(stimulus, options)).rejects.toThrow("agent failed");
    await expect(access(isolatedDir)).rejects.toThrow();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
