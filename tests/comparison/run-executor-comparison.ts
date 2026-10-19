import type { RawEvalSchema } from "@microsoft/vally";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { runAz, setBudget } from "../azure-fixtures/fixture-common.ts";
import { withIsolatedDeployment, type CosmosTarget } from "./isolated-deployment.ts";

const testsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = resolve(testsDir, "../evals/azure-skills/azure-deploy/flask-existing-cosmos.eval.yaml");
const cliPath = join(dirname(createRequire(import.meta.url).resolve("@microsoft/vally-cli/package.json")), "dist/index.js");
let interrupted: NodeJS.Signals | undefined;
let activeChild: ChildProcess | undefined;

async function command(args: string[], logPath: string): Promise<void> {
  if (interrupted) {
    throw new Error(`Comparison interrupted by ${interrupted}.`);
  }
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: testsDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    child.stdout.on("data", (data: Buffer) => {
      process.stdout.write(data);
      writeFileSync(logPath, data, { flag: "a" });
    });
    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(data);
      writeFileSync(logPath, data, { flag: "a" });
    });
    child.on("error", reject);
    child.on("close", code => {
      activeChild = undefined;
      if (interrupted) {
        reject(new Error(`Comparison interrupted by ${interrupted}; see ${logPath}`));
      } else if (code === 0) {
        resolveCommand();
      } else {
        reject(new Error(`vally ${args[0]} failed with exit code ${code}; see ${logPath}`));
      }
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some(arg => arg === "--help" || arg === "-h")) {
    console.log("Usage: npm run compare:executors\nRuns the Flask eval with both executors, cleaning Azure resources between runs.");
    return;
  }
  if (process.argv.slice(2).length > 0) {
    throw new Error("Usage: npm run compare:executors (runs the Flask eval once per executor).");
  }
  if (process.env.MODEL_OVERRIDE || process.env.NO_SKILLS === "true") {
    throw new Error("Unset MODEL_OVERRIDE and NO_SKILLS before comparing executors.");
  }
  for (const skill of ["azure-prepare", "azure-validate", "azure-deploy"]) {
    readFileSync(resolve(testsDir, `../output/azure-skills/skills/${skill}/SKILL.md`));
  }
  const spec = parse(readFileSync(specPath, "utf8")) as RawEvalSchema;
  if (spec.stimuli.length !== 1) {
    throw new Error("This comparison runner requires exactly one Flask stimulus.");
  }
  const stimulus = spec.stimuli[0];
  const environment = stimulus.agent_environment;
  if (!environment || typeof environment === "string" || !environment.env) {
    throw new Error("The Flask stimulus must declare an inline environment.");
  }
  const cosmos = JSON.parse(readFileSync(
    join(dirname(specPath), "fixture/flask-existing-cosmos/cosmos-config.json"), "utf8",
  )) as Record<string, string>;
  const target: CosmosTarget = {
    subscription: environment.env.AZURE_SUBSCRIPTION_ID,
    location: environment.env.AZURE_LOCATION,
    resourceGroup: environment.env.COSMOS_RESOURCE_GROUP,
    account: new URL(cosmos.COSMOS_ENDPOINT).hostname.split(".")[0],
    database: cosmos.COSMOS_DATABASE,
    container: cosmos.COSMOS_CONTAINER,
  };
  const root = join(testsDir, "results", `executor-comparison-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(root, { recursive: true });
  console.log(`Comparison artifacts and recovery context: ${root}`);
  const results: string[] = [];
  for (const executor of ["copilot-sdk-agent-runner", "claude-sdk-agent-runner"]) {
    const runDir = join(root, executor);
    mkdirSync(runDir);
    await withIsolatedDeployment(target, {
      az: args => {
        setBudget(30 * 60 * 1000);
        return runAz(args);
      },
      record: context => writeFileSync(join(runDir, "deployment-context.json"), JSON.stringify(context, null, 2)),
    }, async context => {
      const runSpec = structuredClone(spec);
      const runEnvironment = {
        ...environment,
        env: {
          ...environment.env,
          AZURE_RESOURCE_GROUP: context.resourceGroup,
          AZURE_ENV_NAME: context.environmentName,
        },
        files: [
          ...(environment.files ?? []).map(file => ({ ...file, src: resolve(dirname(specPath), file.src) })),
          { src: join(runDir, "deployment-context.json"), dest: ".eval/deployment-context.json" },
        ],
      };
      runSpec.stimuli[0].agent_environment = runEnvironment;
      const runSpecPath = join(runDir, "eval.yaml");
      writeFileSync(runSpecPath, stringify(runSpec));
      const outputDir = join(runDir, "vally");
      await command([
        "eval", "--eval-spec", runSpecPath,
        "--executor-plugin", join(testsDir, "vally/copilot-sdk-executor.ts"),
        "--executor-plugin", join(testsDir, "vally/claude-sdk-executor.ts"),
        "--grader-plugin", join(testsDir, "vally/vally-graders.ts"),
        "--executor", executor, "--model", spec.defaults?.model ?? "claude-sonnet-5",
        "--judge-model", spec.defaults?.model ?? "claude-sonnet-5",
        "--workers", "1", "--runs", "1", "--max-retries", "0",
        "--output-dir", outputDir,
      ], join(runDir, "eval.log"));
      const runs = readdirSync(outputDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
      if (runs.length !== 1) {
        throw new Error(`Expected one Vally run in ${outputDir}, found ${runs.length}.`);
      }
      const result = join(outputDir, runs[0].name, "results.jsonl");
      readFileSync(result);
      results.push(result);
    });
    writeFileSync(join(runDir, "cleanup-complete.json"), JSON.stringify({ completedAt: new Date().toISOString() }));
  }
  await command([
    "compare", "--baseline", results[0], "--treatment", results[1],
    "--eval-spec", specPath, "--judge-model", spec.defaults?.model ?? "claude-sonnet-5",
    "--verbose", "--output", join(root, "comparison.jsonl"),
  ], join(root, "comparison.txt"));
  console.log(`Comparison and cleanup completed. Reports: ${root}`);
}

const interrupt = (signal: NodeJS.Signals) => {
  interrupted = signal;
  console.error(`Received ${signal}; stopping the active eval before Azure cleanup.`);
  activeChild?.kill(signal);
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
});
