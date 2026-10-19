# Flask deployment with existing Cosmos DB

The `app/` snapshot is the supplied Flask LEGO set browser. Only application
sources, templates, CSS, dependency/container files, and ignore files are copied;
no local `.env`, credentials, virtual environment, or Git metadata is included.
It queries existing data using Azure credentials and never initializes Cosmos
resources. The supplied source has no `azure.yaml` or infrastructure, so the
agent must supply those as needed rather than replace the application.

## Existing Cosmos configuration

The fixture's `cosmos-config.json` and the eval's `agent_environment.env`
supply the verified existing targets:

| Setting | Value |
|---------|-------|
| Subscription | `107ecb4c-adab-4328-bfa2-73af8fa8581f` (yunjchoi subscription) |
| Region | East US 2 (`eastus2`) |
| Resource group | `rg-lego-yunjcho-20261016` |
| Account | `cosmos-lego-yunjcho-20261016-wtcf3i` |
| Endpoint | `https://cosmos-lego-yunjcho-20261016-wtcf3i.documents.azure.com:443/` |
| Database | `LegoDatabase` |
| Container | `legoSets` |
| Account mode | Serverless; local/key authentication disabled |

Do not use a new account or seed data. The eval setup reads the non-secret
`COSMOS_ENDPOINT`, `COSMOS_DATABASE`, and `COSMOS_CONTAINER` identifiers from
`cosmos-config.json`, writes the disposable workspace's `app/.env`, and fails
before starting the agent if any is missing. Setup commands do not receive
`agent_environment.env`, so Cosmos configuration is staged as a file.
To target a different account, update the JSON configuration and the eval's
environment and prompt together; shell environment values do not override them.
The operator needs Azure access to deploy Container Apps and grant the app
identity Cosmos DB data-plane read access.

Run from the repository root after building the plugin and authenticating the
Azure CLI, azd, and Claude SDK executor (see the `vally-eval` skill):

```powershell
Set-Location tests
npm run test:vally -- --eval-spec ..\evals\azure-skills\azure-deploy\flask-existing-cosmos.eval.yaml
```

```bash
cd tests
npm run test:vally -- --eval-spec ../evals/azure-skills/azure-deploy/flask-existing-cosmos.eval.yaml
```

## Isolated executor comparison

After building the plugin and authenticating both executors, run from `tests/`:

```powershell
npm run compare:executors
```

```bash
npm run compare:executors
```

The runner executes Copilot SDK/CLI first, then Claude SDK, with the same model,
prompt, rubric, and app snapshot. Each trial receives a unique resource group,
azd environment name, and user-assigned app identity. The harness grants that
identity the built-in Cosmos DB data reader role scoped to `LegoDatabase/legoSets`.
Agents must reuse those resources, not create their own Cosmos permissions.
The operator needs permission to create/delete groups, identities, and Cosmos
SQL role assignments. Existing Cosmos resources and data are not provisioned,
updated, or deleted.

Before starting each eval, the runner retries only Cosmos role-assignment
errors stating that the trial's newly created principal was not found in
Entra ID. It makes at most six attempts with backoff of 10, 20, 40, 60, and
60 seconds, reusing the same identity, assignment ID, reader role, and container
scope. Retries are logged. Other errors fail immediately; exhausted retries
trigger the same cleanup and stop the comparison before that trial's eval starts.

After **grading**, including execution/grading failures, cleanup removes only
Cosmos assignments belonging to the trial identity and synchronously deletes
the ownership-tagged trial group. It verifies group absence and that Cosmos
assignments match the pre-run snapshot before allowing the next executor.
Additional groups, unexpected permission changes, or any cleanup error stop
the comparison without sweeping unrelated resources. No resources from older
manual runs are automatically deleted; review those before comparing.

Artifacts are under `tests/results/executor-comparison-<timestamp>/`. Each
executor directory contains `deployment-context.json`, the generated eval,
`eval.log`, Vally results, and (only after verified cleanup)
`cleanup-complete.json`. The root contains `comparison.txt` and
`comparison.jsonl`. The comparison judge uses timelines/output/metrics, not
workspace diffs; individual eval grades include diffs.

Normal interruption attempts cleanup after the child exits. A forced process
kill or machine shutdown cannot guarantee cleanup. If no cleanup marker exists,
inspect the saved deployment context, ownership tag, and role assignments,
then remove only that run's group and identity-owned assignments before retrying.
Never delete `rg-lego-yunjcho-20261016`. Concurrent subscription/RBAC changes
can conservatively fail the snapshot check and require manual review.

Both runs are live deployments and incur Azure charges. Running the eval
directly (the commands above the comparison section) does **not** enable this
cleanup lifecycle. Grading and prompt constraints detect violations after
execution; they are not a permission boundary.
