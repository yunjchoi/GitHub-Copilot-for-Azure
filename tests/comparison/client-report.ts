import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type ObjectValue = Record<string, unknown>;
type Statistic = { count: number; total: number | null; mean: number | null; min: number | null; max: number | null };
type Grade = { name: string; passed: boolean | null; score: number | null; evidence: string; greeting: string };
type Trial = {
  stimulus: string; cohort: string; line: number; status: string; model: string; executor: string;
  passed: boolean | null; score: number | null; error: string; grades: Grade[];
  activeTimeMs: number | null; toolCalls: number | null; turns: number | null;
  tokens: Record<string, number | null>; usageModels: string[];
};
type Client = {
  id: string; label: string; source: string | null; trials: Trial[]; models: string[];
  quality: Statistic; passed: number; graded: number; executionErrors: number;
  activeTimeMs: Statistic; toolCalls: Statistic; turns: Statistic;
  tokens: Record<string, Statistic>;
};
const tokenFields = ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const definitions = {
  resultQuality: "Mean recorded Vally grade score and all-grader trial pass rate. A successful executor exit is not a quality pass.",
  activeCompletionTime: "Executor-reported trajectory.metrics.wallTimeMs: execution elapsed time, including tool/cloud waits and any executor setup included by that runtime. Excludes outer grading, cleanup, and time between clients. Not model-processing-only time.",
  toolCalls: "Recorded tool_call count. Built-in tool granularity and task-management tools differ between clients.",
  turns: "Native trajectory turnCount (turn_end events), not a normalized number of model reasoning steps. Claude may record a whole prompt session as one turn; Copilot records assistant iterations.",
  tokens: "Raw native input/output and cache counters, summed across reported models. totalTokens is input + output, NOT input + output + cache. Cache inclusion and event aggregation differ between runtimes; these are not equivalent billing units.",
  overall: "Observed quality and execution trade-offs plus the existing pairwise judge, when available. No weighted composite score or automatic token/turn efficiency winner.",
};

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected ${label} object.`);
  return value as ObjectValue;
}
function optionalObject(value: unknown, label: string): ObjectValue {
  return value === undefined || value === null ? {} : object(value, label);
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function boolean(value: unknown): boolean | null { return typeof value === "boolean" ? value : null; }
function array(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected ${label} array.`);
  return value;
}
function stats(values: (number | null)[]): Statistic {
  const available = values.filter((value): value is number => value !== null);
  const total = available.length ? available.reduce((sum, value) => sum + value, 0) : null;
  return {
    count: available.length, total, mean: total === null ? null : total / available.length,
    min: available.length ? Math.min(...available) : null, max: available.length ? Math.max(...available) : null,
  };
}
async function jsonl(file: string): Promise<{ row: ObjectValue; line: number }[]> {
  return (await readFile(file, "utf8")).split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ row: object(JSON.parse(line), "JSONL record"), line: index + 1 }];
    } catch (error) {
      throw new Error(`Invalid JSONL at ${path.basename(file)}:${index + 1}`, { cause: error });
    }
  });
}
function parseTrial(row: ObjectValue, line: number): Trial {
  const trajectory = optionalObject(row.trajectory, "trajectory");
  const stimulus = optionalObject(trajectory.stimulus, "stimulus");
  const metadata = optionalObject(trajectory.metadata, "trajectory metadata");
  const metrics = optionalObject(trajectory.metrics, "trajectory metrics");
  const usage = optionalObject(metrics.tokenUsage, "token usage");
  const grade = optionalObject(row.gradeResult, "grade result");
  const events = trajectory.events === undefined ? null : array(trajectory.events, "events").map(event => object(event, "event"));
  const name = text(stimulus.name) || text(row.stimulus);
  if (!name) throw new Error(`Missing stimulus name at result line ${line}.`);
  const hasUsage = (number(usage.callCount) ?? 0) > 0
    || tokenFields.some(field => (number(usage[field]) ?? 0) > 0);
  const score = number(grade.score);
  if (score !== null && score > 1) throw new Error(`Grade score outside [0, 1] at result line ${line}.`);
  return {
    stimulus: name, cohort: JSON.stringify([text(row.evalName), text(row.variant), name]),
    line, status: text(row.status) || "unknown", model: text(row.model) || text(metadata.model) || "unknown",
    executor: text(metadata.executor) || "unknown",
    passed: row.status === "error" ? false : boolean(grade.passed), score,
    error: text(row.error) || text(optionalObject(typeof row.error === "object" ? row.error : undefined, "error").message),
    grades: array(grade.details, "grade details").map(raw => {
      const detail = object(raw, "grader");
      const info = optionalObject(detail.metadata, "grader metadata");
      return {
        name: text(detail.graderType) || text(detail.name) || "unnamed",
        passed: boolean(detail.passed), score: number(detail.score),
        evidence: text(detail.evidence), greeting: text(info.greeting),
      };
    }),
    // Do not substitute durationMs: it includes grading, unlike the executor timer.
    activeTimeMs: number(metrics.wallTimeMs),
    toolCalls: number(metrics.toolCallCount) ?? (events ? events.filter(event => event.type === "tool_call").length : null),
    turns: number(metrics.turnCount) ?? (events ? events.filter(event => event.type === "turn_end").length : null),
    tokens: Object.fromEntries(tokenFields.map(field => [field, hasUsage ? number(usage[field]) : null])),
    usageModels: Object.keys(optionalObject(usage.byModel, "usage by model")).sort(),
  };
}
function summarize(id: string, source: string | null, trials: Trial[]): Client {
  return {
    id, label: id === "copilot" ? "Copilot CLI" : id === "claude" ? "Claude Code" : id,
    source, trials, models: [...new Set(trials.map(trial => trial.model))].sort(),
    quality: stats(trials.map(trial => trial.score)),
    passed: trials.filter(trial => trial.passed === true).length,
    graded: trials.filter(trial => trial.passed !== null).length,
    executionErrors: trials.filter(trial => trial.status === "error").length,
    activeTimeMs: stats(trials.map(trial => trial.activeTimeMs)),
    toolCalls: stats(trials.map(trial => trial.toolCalls)), turns: stats(trials.map(trial => trial.turns)),
    tokens: Object.fromEntries(tokenFields.map(field => [field, stats(trials.map(trial => trial.tokens[field]))])),
  };
}
function coverage(client: Client): string {
  return JSON.stringify(client.trials.map(trial => trial.cohort).sort());
}
function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
const format = (value: number | null) => value === null ? "N/A" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const percent = (value: number | null) => value === null ? "N/A" : `${format(value * 100)}%`;
const time = (value: number | null) => value === null ? "N/A" : `${format(value / 1000)} s`;
function cell(stat: Statistic, count: number, formatter = format): string {
  if (!stat.count) return "N/A";
  return `${formatter(stat.mean)}${stat.count > 1 ? ` (${formatter(stat.min)}-${formatter(stat.max)})` : ""}`
    + (stat.count !== count ? ` [${stat.count}/${count} recorded]` : "");
}
function link(directory: string, file: string): string {
  return path.relative(directory, path.resolve(directory, file)).split(path.sep).map(part => encodeURIComponent(part)).join("/");
}
function artifactPath(directory: string, file: string): string {
  if (path.isAbsolute(file)) throw new Error("Manifest result paths must be relative to the comparison directory.");
  const resolved = path.resolve(directory, file);
  const relative = path.relative(directory, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Manifest result paths must stay inside the comparison directory.");
  }
  return resolved;
}

export async function generateClientReport(directory: string): Promise<string> {
  directory = path.resolve(directory);
  const manifest = object(JSON.parse(await readFile(path.join(directory, "comparison-run.json"), "utf8")), "comparison manifest");
  const results = object(manifest.results, "manifest results");
  const ids = [...new Set(["copilot", "claude", ...Object.keys(results)])];
  const clients = await Promise.all(ids.map(async id => {
    if (results[id] === undefined) return summarize(id, null, []);
    const source = text(results[id]);
    if (!source) throw new Error(`Missing result path for ${id}.`);
    const file = artifactPath(directory, source);
    const records = await jsonl(file);
    return summarize(id, path.relative(directory, file), records
      .filter(({ row }) => row.type === "trial-result" || (row.type === undefined && "status" in row && "trajectory" in row))
      .map(({ row, line }) => parseTrial(row, line)));
  }));
  const warnings: string[] = [];
  const sameCoverage = clients.every(client => client.trials.length > 0 && coverage(client) === coverage(clients[0]));
  const expectedRuns = number(manifest.runs);
  const expectedStimuli = manifest.stimuli === undefined ? null : array(manifest.stimuli, "manifest stimuli").map(value => text(value));
  const complete = sameCoverage && clients.every(client => {
    const names = [...new Set(client.trials.map(trial => trial.stimulus))];
    return (!expectedStimuli || (names.length === expectedStimuli.length && expectedStimuli.every(name => names.includes(name))))
      && (expectedRuns === null || names.every(name => client.trials.filter(trial => trial.stimulus === name).length === expectedRuns));
  });
  if (!complete) warnings.push("Incomplete or unequal trial coverage. Missing trials are not zeroes; no cross-client ranking is made.");
  if (manifest.status !== "completed" && manifest.status !== "collected") warnings.push(`Run status: ${text(manifest.status) || "unknown"}. This is a diagnostic report, not proof of a successful run.`);
  if (text(manifest.error)) warnings.push(`Run error: ${text(manifest.error)}`);
  if (clients.some(client => client.trials.length === 1)) warnings.push("Only one trial is recorded for at least one client. These observations do not establish a general client advantage.");
  if (clients.some(client => client.quality.count !== client.trials.length
    || client.activeTimeMs.count !== client.trials.length || client.toolCalls.count !== client.trials.length
    || client.turns.count !== client.trials.length || tokenFields.some(field => client.tokens[field].count !== client.trials.length))) {
    warnings.push("Some measurements are unavailable. N/A is not zero; partial aggregates show their recorded sample count.");
  }
  warnings.push("Native turn counts and token counters are not directly comparable. Do not interpret their ratios as reasoning efficiency, token savings, or cost savings.");
  warnings.push("Elapsed execution includes tool/cloud waits. Pure model-active time is not consistently recorded; runtime timing boundaries and tool granularity differ.");

  let judge: ObjectValue[] = [];
  const judgeFile = path.join(directory, "comparison.jsonl");
  if (manifest.skipJudge !== true) {
    try {
      judge = (await jsonl(judgeFile)).map(record => record.row).filter(row => row.type === "comparison");
      if (!judge.length) warnings.push("The pairwise judge artifact contains no comparison records.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      warnings.push("Pairwise judgment is unavailable: comparison.jsonl was not produced.");
    }
  }
  const judgments = judge.flatMap(record => array(record.stimuli, "comparison stimuli").flatMap(raw => {
    const stimulus = object(raw, "comparison stimulus");
    return array(stimulus.trials, "comparison trials").map(rawTrial => {
      const trial = object(rawTrial, "comparison trial");
      const evidence = text(trial.evidence);
      const criteria = array(trial.criteria, "comparison criteria").map(rawCriterion => object(rawCriterion, "comparison criterion"));
      const unverified = criteria.some(criterion => /position-swap unverified/i.test(text(criterion.evidence)));
      if (unverified) warnings.push("Pairwise per-criterion position-swap checks were unverified; those criterion verdicts defaulted to ties.");
      return {
        stimulus: text(stimulus.stimulusName), winner: text(trial.winner),
        preferredClient: trial.errored === true ? null : trial.winner === "baseline" ? "copilot" : trial.winner === "treatment" ? "claude" : null,
        magnitude: text(trial.magnitude), evidence, errored: trial.errored === true, unverified,
      };
    });
  }));
  const assessment: string[] = [];
  const comparable = complete && ["completed", "collected"].includes(text(manifest.status))
    && clients.every(client => client.trials.every(trial => ["success", "completed"].includes(trial.status)));
  if (comparable && clients.every(client => client.quality.count === client.trials.length)) {
    const ranked = [...clients].sort((a, b) => b.quality.mean! - a.quality.mean!);
    assessment.push(ranked[0].quality.mean === ranked.at(-1)!.quality.mean
      ? "Observed mean result quality is tied across clients."
      : `${ranked[0].label} has the highest observed mean result-quality score (${percent(ranked[0].quality.mean)}). This is a sample result, not a general winner.`);
  } else assessment.push("No result-quality ranking: run state, coverage, grades, or execution outcomes are incomplete.");
  for (const [key, label, formatter] of [
    ["activeTimeMs", "mean active completion time", time],
    ["toolCalls", "mean recorded tool calls", format],
  ] as const) {
    if (comparable && clients.every(client => client[key].count === client.trials.length)) {
      const ranked = [...clients].sort((a, b) => a[key].mean! - b[key].mean!);
      assessment.push(ranked[0][key].mean === ranked.at(-1)![key].mean
        ? `Observed ${label} is tied.`
        : `${ranked[0].label} has the lowest ${label} (${formatter(ranked[0][key].mean)}). Lower does not imply better quality.`);
    }
  }
  assessment.push("No combined efficiency score is assigned: quality, elapsed execution, tool calls, native turns, and token accounting measure different things.");
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), status: text(manifest.status),
    complete, definitions, clients, assessment, judgeModel: text(manifest.judgeModel),
    judgeStatus: manifest.skipJudge === true ? "skipped" : judge.length ? "recorded" : "unavailable",
    judgments, warnings: [...new Set(warnings)],
  };
  const lines = [
    "# Cross-client evaluation report", "",
    `Run status: **${escape(report.status)}**. Judge: **${escape(report.judgeModel || "not recorded")}**.`,
    "Report generation reads saved artifacts only; it does not rerun agents, judges, or deployments.", "",
    "## Comparison summary", "",
    `| Metric | ${clients.map(client => escape(client.label)).join(" | ")} |`,
    `|---|${clients.map(() => "---").join("|")}|`,
  ];
  const row = (name: string, value: (client: Client) => string) =>
    lines.push(`| ${name} | ${clients.map(value).join(" | ")} |`);
  row("Requested model", client => escape(client.models.join(", ") || text(manifest[`${client.id}Model`]) || "N/A"));
  row("Trials recorded", client => String(client.trials.length));
  row("Result quality: mean score (range)", client => cell(client.quality, client.trials.length, percent));
  row("Trials passing all graders", client => `${client.passed}/${client.graded} graded; ${client.trials.length - client.graded} ungraded`);
  row("Execution errors", client => String(client.executionErrors));
  row("Active completion time: mean (range)", client => cell(client.activeTimeMs, client.trials.length, time));
  row("Tool calls: mean (range)", client => cell(client.toolCalls, client.trials.length));
  row("Turns: native mean (not equivalent)", client => cell(client.turns, client.trials.length));
  row("Tokens: raw total mean (not equivalent)", client => cell(client.tokens.totalTokens, client.trials.length));
  for (const [field, name] of [
    ["inputTokens", "Input tokens"], ["outputTokens", "Output tokens"],
    ["cacheReadTokens", "Cache-read tokens"], ["cacheWriteTokens", "Cache-write tokens"],
  ] as const) row(`${name}: mean`, client => cell(client.tokens[field], client.trials.length));
  row("Models observed in usage", client => escape([...new Set(client.trials.flatMap(trial => trial.usageModels))].join(", ") || "N/A"));
  lines.push("", "## Overall assessment", "", ...assessment.map(item => `- ${escape(item)}`),
    "", "## Pairwise quality judgment", "",
    `Status: **${report.judgeStatus}**. Baseline = Copilot CLI; treatment = Claude Code.`, "");
  for (const judgment of judgments) lines.push(
    `- **${escape(judgment.stimulus)}**: ${judgment.errored ? "judge error" : escape(judgment.preferredClient || judgment.winner || "unavailable")} (${escape(judgment.magnitude)}). ${escape(judgment.evidence)}`,
  );
  lines.push("", "## Measurement definitions and limitations", "",
    ...Object.values(definitions).map(value => `- ${escape(value)}`),
    ...report.warnings.map(warning => `- **${escape(warning)}**`),
    "", "## Per-trial evidence", "");
  for (const client of clients) {
    lines.push(`### ${escape(client.label)}`, "");
    if (!client.source) { lines.push("No result artifact was recorded.", ""); continue; }
    lines.push(`[Original results and trajectories](${link(directory, client.source)})`, "");
    for (const trial of client.trials) {
      lines.push(`#### ${escape(trial.stimulus)} (result line ${trial.line})`, "",
        `Execution: **${escape(trial.status)}**; quality: **${percent(trial.score)}**; all-graders pass: **${trial.passed === null ? "N/A" : trial.passed}**.`,
        `Active completion: ${time(trial.activeTimeMs)}; tool calls: ${format(trial.toolCalls)}; native turns: ${format(trial.turns)}; raw total tokens: ${format(trial.tokens.totalTokens)}.`, "",
        "| Grader | Result | Evidence |", "|---|---|---|");
      for (const grade of trial.grades) lines.push(`| ${escape(grade.name)} | ${grade.passed === null ? "N/A" : grade.passed ? "Pass" : "Fail"} | ${escape(grade.evidence)}${grade.greeting ? `<br>Observed greeting: ${escape(grade.greeting)}` : ""} |`);
      if (trial.error) lines.push("", `Error: ${escape(trial.error)}`);
      lines.push("");
    }
  }
  const destination = path.join(directory, "comparison-report.md");
  await writeFile(path.join(directory, "comparison-report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(destination, lines.join("\n") + "\n");
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { "comparison-dir": { type: "string" }, help: { type: "boolean", short: "h" } } });
    if (values.help) console.log("Usage: npm run compare:report -- --comparison-dir <directory-containing-comparison-run.json>");
    else {
      if (!values["comparison-dir"]) throw new Error("--comparison-dir is required.");
      console.log(`Comparison report: ${await generateClientReport(values["comparison-dir"])}`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
