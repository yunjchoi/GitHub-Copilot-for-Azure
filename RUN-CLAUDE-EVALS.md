# Run evaluations with Claude

Use a reviewed eval specification for Claude-only or paired evaluations.
The dedicated live Foundry comparison below creates and verifies real resources.
For an on-demand GitHub Actions run backed by a personal Claude subscription,
follow [the manual CI guide](CLAUDE-MANUAL-CI.md#run-with-your-claude-subscription).

## 1. Open the worktree and build

Use a dedicated PowerShell terminal:

```powershell
Set-Location <repository-root>
git branch --show-current
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
```

Install and build the upstream Vally Claude executor as described in
[the eval setup guide](evals/README.md#run-with-claude-code).

The test package declares `tsx`, which launches its TypeScript runners, as a
development dependency. If a runner reports that `tsx` is missing, restore test
dependencies from the repository root with `npm --prefix tests ci --include=dev`.
No global installation or on-demand `npx` download is needed for these commands.

## 2. Configure the executor and authentication

Point to your upstream executor build:

```powershell
$vally = "<path-to-vally-worktree>"
$env:VALLY_CLAUDE_EXECUTOR_MODULE = (Resolve-Path "$vally\plugins\executors\vally-executor-claude-cli\dist\index.js").Path

# Remove overrides that conflict with the comparison policy.
$env:MODEL_OVERRIDE = $null
$env:NO_SKILLS = $null

$env:CLAUDE_CLI_PATH = (Get-Command claude.exe -ErrorAction Stop).Source
& $env:CLAUDE_CLI_PATH --version
if ($LASTEXITCODE -ne 0) { throw "Claude executable failed." }
```

This locates the native executable automatically, avoiding npm `.cmd`/`.ps1`
wrappers. If `Get-Command` fails, install the native Claude Code executable or
add its directory to PATH before continuing. Run this setup in the same terminal
as the tests. It also replaces any stale placeholder value in `CLAUDE_CLI_PATH`.

Sign in through `claude` and `copilot` if needed. When using an explicit native
path, launch `& $env:CLAUDE_CLI_PATH` to sign in to Claude.

**Both authentications are needed:** Claude executes the prompts; Copilot runs
the LLM graders. Azure login is required for live deployment cases, not for
non-deploying offline cases. Never put credentials in eval files.

## 3. Run a reviewed eval with Claude

Replace the eval path with an existing specification and the model placeholders
with explicit model IDs available to your accounts. Review the eval's side
effects and prerequisites before running. Use the same PowerShell terminal as
the setup steps.

```powershell
Set-Location <repository-root>\tests

$claudeModel = "<explicit-Claude-model-ID>"
$judgeModel = "<Copilot-supported-judge-model-ID>"
$evalSpec = "<path-to-reviewed-eval.yaml>"

$previousComparisonPolicy = $env:VALLY_FAIR_COMPARISON
$env:VALLY_FAIR_COMPARISON = "true"
try {
    npm run test:vally -- `
        --executor claude-cli `
        --eval-spec $evalSpec `
        --model $claudeModel `
        --judge-model $judgeModel `
        --runs 1 --workers 1 --max-retries 0 --timeout 5m `
        --require-pass --junit

    if ($LASTEXITCODE -ne 0) { throw "Evaluation failed; inspect the results." }
} finally {
    $env:VALLY_FAIR_COMPARISON = $previousComparisonPolicy
}
```

`--runs 1` runs each selected stimulus once.
`--require-pass` makes grading failures return a nonzero exit code.

The comparison policy gives the agent the exact shared skill pool and enables
only explicitly configured MCP servers. Do not combine `--suite` with
`--eval-spec` or `--skill`. For the live Foundry hello-world eval, use the
dedicated runner below instead so ownership, verification, and cleanup are wired.

## 4. Run the Claude-versus-Copilot comparison

From the same `tests` directory, with the executor and model variables above
configured:

```powershell
$copilotModel = "<explicit-Copilot-model-ID>"

npm run compare:clients -- `
    --eval-spec $evalSpec `
    --copilot-model $copilotModel `
    --claude-model $claudeModel `
    --judge-model $judgeModel `
    --runs 3 --timeout 5m --fail-on-regression

if ($LASTEXITCODE -ne 0) { throw "Client comparison failed." }
```

This runs each selected stimulus three times per client, plus per-case and
pairwise judging. The runner applies the shared comparison policy automatically,
snapshots the built skills, and randomizes which client runs first.

Use equivalent model versions where available. Otherwise, interpret this as a
comparison of both client and model differences. The paired runner rejects
floating aliases such as `sonnet` and `latest`.

`--fail-on-regression` gates significant relative regressions, not absolute
grader failures. Use the single-client `--require-pass` run when every grader
must pass. `--skip-judge` skips only pairwise judging; the per-case LLM graders
still run and incur usage.

See [the comparison guide](tests/comparison/README.md) for the full policy and
remaining differences between runtimes.

## 5. Find the results

Paths below are relative to the repository root:

| Run | Output location | Contents |
| --- | --- | --- |
| Claude only | `tests\results-claude\` | Per-run trajectories and grader results in `results.jsonl`, plus JUnit output. |
| Paired comparison | `tests\results-comparison\comparison-*\` | Both clients' results, `comparison-run.json`, and `comparison.jsonl`. |

The comparison manifest records the model IDs, trial settings, execution order,
and exact result paths. `comparison.jsonl` is omitted when using `--skip-judge`.

New comparisons also produce **`comparison-report.md`**, with a side-by-side
summary of quality, active completion time, tool calls, native turns, token
breakdowns, and overall assessment. Detailed grader evidence and trajectory links
are included. A structured copy is saved as `comparison-report.json`.

To generate this report for the saved live pair without rerunning agents or Azure
deployments, run from `tests`:

```powershell
npm run compare:report -- --comparison-dir <comparison-directory>
```

Active completion time includes tool waits but excludes grading and cleanup.
Native turns and token totals have different accounting across clients; the
report shows those limitations rather than claiming an efficiency winner.

## Safety and scope

These runs incur model and judge usage. Their scope and side effects depend on
the selected eval; inspect its prompts, environment, and graders first.

Use a disposable environment without production credentials, production data,
or writable remotes. The offline instructions and graders are **not a security
sandbox** and do not technically block commands or network access.

Successful trajectory grading alone does not establish that a real application
was deployed. Use independent remote verification for live deployment outcomes.

## Separate live Foundry deployment comparison

For real deployments of the hello-world hosted agent, use the dedicated live
runner. It uses your default Azure subscription,
creates one isolated resource group per client, verifies a remote greeting, and
deletes the owned groups after saving evidence.

After configuring the native Claude path, upstream executor module, model IDs,
and Azure/azd authentication, run from `tests`:

```powershell
npm run compare:foundry-live -- --execute --copilot-model claude-sonnet-5 --claude-model claude-sonnet-5 --judge-model gpt-5.5 --location northcentralus --timeout 30m
if ($LASTEXITCODE -ne 0) { throw "Live comparison failed; inspect live-run.json and live-outcome.json." }
```

Add `--client claude` to run only Claude against this stimulus while retaining
independent verification and owned-resource cleanup.

This incurs Azure and model charges. See the
[live comparison guide](tests/comparison/README.md#live-foundry-hello-world-comparison)
for permissions, independent verification, output paths, and cleanup limitations.
The CI workflow publishes summarized comparison reports, not raw trajectories.
