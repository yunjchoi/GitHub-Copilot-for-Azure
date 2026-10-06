import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const vallyCommit = "23ecce600f1eb4107593c82deb57682256312764";
export const cacheDir = path.resolve(import.meta.dirname, "..", ".cache", "vally-claude-executor");
export const executorModule = path.join(
  cacheDir,
  "plugins",
  "executors",
  "vally-executor-claude-cli",
  "dist",
  "index.js",
);

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}.`)));
  });
}

async function runNpm(args: string[], cwd: string): Promise<string> {
  const npmEntry = process.env.npm_execpath;
  if (npmEntry) return run(process.execPath, [npmEntry, ...args], cwd);
  return run("npm", args, cwd);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function setupClaudeExecutor(): Promise<string> {
  await mkdir(path.dirname(cacheDir), { recursive: true });
  if (!await exists(path.join(cacheDir, ".git"))) {
    await run("git", ["clone", "https://github.com/microsoft/vally.git", cacheDir]);
    await run("git", ["checkout", vallyCommit], cacheDir);
  } else {
    const current = await run("git", ["rev-parse", "HEAD"], cacheDir);
    if (current !== vallyCommit) {
      throw new Error(
        `Cached Vally checkout is at ${current}, expected ${vallyCommit}. `
        + `Remove ${path.relative(process.cwd(), cacheDir)} and rerun compare:setup.`,
      );
    }
  }
  if (!await exists(executorModule)) {
    await runNpm(["ci", "--ignore-scripts"], cacheDir);
    await runNpm(["run", "build", "--workspace", "@microsoft/vally-executor-claude-cli"], cacheDir);
  }
  await access(executorModule);
  return executorModule;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg === "--help" || arg === "-h")) {
      console.log("Usage: npm run compare:setup\nClones and builds the pinned Vally Claude executor under tests/.cache/.");
    } else {
      console.log(`Claude executor ready: ${await setupClaudeExecutor()}`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
