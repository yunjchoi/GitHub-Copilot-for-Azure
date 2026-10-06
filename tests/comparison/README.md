# Live Foundry client comparison

This directory contains an opt-in test that asks Copilot CLI and Claude Code to
create the same Microsoft Foundry hosted hello-world agent. The runner gives
each client a fresh resource group, independently verifies the deployed agent,
deletes the group, and writes a side-by-side report.

The test makes paid model calls and creates temporary Azure resources. Use a
disposable test subscription and credentials with only the permissions needed
to create the resources in the assigned groups.

## Prerequisites

- Node.js 22.14 or later, Git, Azure CLI, and Azure Developer CLI
- The Microsoft Foundry azd extension
- Authenticated `az`, `azd`, `copilot`, and `claude` CLIs
- Permission to create resource groups, Foundry resources, model deployments,
  and project-scoped role assignments in the Azure CLI default subscription

From the repository root:

```shell
npm ci
npm run build
npm --prefix tests ci
npm --prefix tests run compare:setup
azd extension install microsoft.foundry
az account show
```

`compare:setup` clones the pinned upstream Vally Claude executor into the
ignored `tests/.cache/` directory and builds it. The test finds that checkout
automatically, so no developer-specific path is required. To use an existing
executor build instead, set `VALLY_CLAUDE_EXECUTOR_MODULE` to its
`dist/index.js`. Set `CLAUDE_CLI_PATH` only when the native Claude executable is
not on `PATH`.

Confirm that `az account show` identifies the intended disposable subscription.
The runner reads that default subscription once and never changes it.

## Run the Foundry test

From `tests`, run the same command in PowerShell or Bash after substituting
explicit model IDs supported by your accounts:

```shell
npm run compare:foundry-live -- --execute --copilot-model <copilot-model-id> --claude-model <claude-model-id> --judge-model <judge-model-id> --location northcentralus --timeout 30m
```

`--execute` is mandatory. The paired run performs exactly one trial per client.
Use `--client claude` for a Claude-only smoke test; that mode verifies and cleans
the deployment but does not produce a cross-client report.

The eval is fixed at `comparison/live/hello-world.eval.yaml` and intentionally
outside normal eval discovery. Do not run it directly because the lifecycle
wrapper supplies the isolated resource groups, custom verifier, and cleanup.

## Artifacts and report

Each run creates an ignored directory under
`tests/results-comparison/foundry-live-*` containing:

- `live-run.json`: assigned resource groups, verification status, and cleanup
- `<client>/live-outcome.json`: independent remote verification evidence
- `comparison-*/comparison-run.json`: portable run metadata and relative result
  paths
- `comparison-*/comparison-report.md`: the side-by-side human-readable report
- `comparison-*/comparison-report.json`: the structured report

The report compares recorded result quality, active completion time, tool calls,
native turns, token counters, grader evidence, and pairwise preference. Native
turn and token boundaries differ between clients, so the report treats those
values as diagnostic rather than a normalized efficiency or cost score.

Regenerate a report from saved artifacts without rerunning agents or Azure:

```shell
npm run compare:report -- --comparison-dir <directory-containing-comparison-run.json>
```

All persisted links and result locations are relative to the artifact directory.
The whole `foundry-live-*` directory can therefore be moved to another checkout
without editing paths.

## Cleanup and failure recovery

The runner creates each group immediately before its client runs and deletes it
after independent verification. Cleanup checks the exact group name and the
`vally-run` ownership tag or scoped ARM deployment marker before deletion.
Conflicting or missing ownership blocks automatic cleanup.

Terminal closure, machine failure, or forced cancellation can interrupt cleanup.
In that case, inspect `live-run.json`, independently verify ownership, and remove
only the exact recorded groups. Never run broad subscription cleanup.

Raw trajectories can contain command output and account metadata. Review them
before sharing and do not commit generated result directories or credentials.
