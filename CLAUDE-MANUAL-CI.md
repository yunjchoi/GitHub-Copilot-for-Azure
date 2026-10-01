# Run the live Foundry comparison with Claude

## Goal and scope

The dedicated
[test-claude-integration.yml](.github/workflows/test-claude-integration.yml)
workflow runs the existing live Foundry hello-world comparison on demand. The
eval contains one prompt/stimulus, run once with Copilot and once with Claude.
Each client receives a separate temporary resource group in the default Azure
subscription configured by the protected `cideploytest` environment.

## Run with your Claude subscription

GitHub does not provide caller-owned secrets to a shared workflow automatically.
Because a job can use only one GitHub Environment, both the Azure OIDC variables
and approved personal Claude tokens must be stored in `cideploytest`.

1. Install Claude Code locally and run `claude setup-token`.
2. Ask a repository administrator to add the token to `cideploytest` as
  `CLAUDE_CODE_OAUTH_TOKEN_<USERNAME>`, using uppercase letters, digits, and
  underscores. Never put the token itself in a workflow input.
3. Keep `cideploytest` protected with trusted deployment branches and required
  reviewers. A reviewer must inspect the selected ref before approving access
  to the shared Azure subscription and personal token.
4. Open **Actions → Foundry Live Claude Comparison - manual → Run workflow**,
  select the branch, and enter the environment secret's name.

The workflow scopes the token to the evaluation step, installs Claude Code
`2.1.281`, builds Vally executor `0.2.0` from pinned commit
`23ecce600f1eb4107593c82deb57682256312764`, uses the job-scoped GitHub token for
the Copilot client and graders, and uploads only generated comparison reports.
Raw trajectories remain runner-local because they can contain command output,
runtime paths, and account metadata.

The workflow authenticates `az` and `azd` through the same OIDC variables used
by existing integration evals. It verifies that `az account show` resolves to
`cideploytest`'s `AZURE_SUBSCRIPTION_ID`; the live runner then captures that
default subscription without changing it. The runner creates an ownership-marked
resource group immediately before each client trial, independently verifies the
deployed hosted agent, and deletes the group afterward. Abrupt job cancellation
can still leave resources requiring ownership-checked cleanup.

This shared-subscription workflow is not available to arbitrary fork users:
GitHub does not expose the upstream repository's environments, OIDC trust, or
secrets to forks. A fork must configure its own `cideploytest` environment and
Azure federated identity, targeting a subscription owned by that fork's operator.

The workflow file must exist on the repository's default branch before GitHub
will accept `workflow_dispatch` events for it. Keeping the implementation only
on a remote feature branch is useful for review, but it cannot be run there
until the workflow is first merged to the default branch. After that, the Run
workflow UI can target another branch containing compatible workflow code.

## Optional organization-owned authentication

The existing [integration workflow](.github/workflows/test-all-integration.yml)
uses three relevant permissions: `contents: read`, `copilot-requests: write`,
and `id-token: write`.

| Purpose | Existing approach | Approach for the manual Claude job |
| --- | --- | --- |
| Copilot inference | `${{ github.token }}` passed to the pinned `mvkaran/setup-copilot-cli` action, with `copilot-requests: write` | Reuse for LLM graders and, when comparing clients, the Copilot baseline |
| Azure deployment | GitHub OIDC federation through `azure/login` and `azd auth login`, using environment variables from `cideploytest` | Reuse only for live deployment tests |
| Claude inference | Named personal subscription token in `cideploytest` | Replace with Anthropic workload identity federation for organization-owned CI |

Copilot's job-scoped GitHub token is not an OIDC token. These mechanisms are
different, but both avoid storing a developer's interactive login. Anthropic
federation is the closest architectural match. The GitHub token cannot be reused
directly as a Claude credential, and Azure login does not authenticate direct
Anthropic API requests.

### Anthropic administrator setup

1. Create a dedicated Anthropic service account and assign it to an approved
   evaluation workspace with model access, rate limits, and spending controls.
2. Register GitHub Actions as an OIDC issuer:
   `https://token.actions.githubusercontent.com`.
3. Create a federation rule bound to that service account and workspace. Restrict
   the audience and claims to `microsoft/GitHub-Copilot-for-Azure`, the intended
   workflow, and approved execution context. Account for environment-based
   subjects when using `cideploytest`; enforce allowed branches with environment
   protection and appropriate claim conditions.
4. Record the organization, federation-rule, service-account, and workspace IDs
   as Actions configuration variables, not credentials.

### Workflow-side Claude setup

- Grant `id-token: write` to the job that needs federation.
- Configure the supported Claude CLI federation path with
  `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, and the applicable
  `ANTHROPIC_SERVICE_ACCOUNT_ID` / `ANTHROPIC_WORKSPACE_ID` settings.
- Obtain a GitHub OIDC identity token with the audience required by the rule.
  If using `ANTHROPIC_IDENTITY_TOKEN_FILE`, write it to a restricted temporary
  file outside evaluation workspaces and artifact directories.
- Ensure both the source GitHub identity token and exchanged Anthropic access
  token can refresh for the entire run. Do not assume a one-time token fetch
  will last through a live deployment.
- Remove competing API-key, bearer-token, and personal OAuth credentials so
  authentication precedence cannot silently bypass federation.
- Never log tokens, upload credential/configuration directories, or copy a
  developer's `.credentials.json` into CI.

**Compatibility is a prerequisite, not an established result.** Federation has
not been tested with this branch's previously used Claude CLI and upstream Vally
executor. Select and pin a supported CLI version, then verify headless execution,
token refresh, and compatibility with the executor's isolated configuration.
Do not use a CLI mode that disables federation credential discovery.

If federation cannot be enabled yet, use an explicitly approved,
organization-owned `ANTHROPIC_API_KEY` in the protected Actions environment,
scoped to the evaluation step. This is a practical fallback, but adds a
long-lived secret and rotation requirements. Do not silently fall back when
federation fails. A personal `CLAUDE_CODE_OAUTH_TOKEN` is the least consistent
option for this repository's unattended workload model.

## Workflow behavior

- Runs only through `workflow_dispatch`; no recurring schedule is added.
- Uses `tests/comparison/live/hello-world.eval.yaml` indirectly through
  `npm run compare:foundry-live -- --execute`; do not invoke the eval directly.
- Executes exactly one stimulus once per client, sequentially, with one worker
  and no retries.
- Uses the `northcentralus` location and the Azure CLI default subscription set
  by `azure/login` from `cideploytest`.
- Serializes live runs for this repository and never cancels an active run, so
  cleanup has time to complete.
- Fails when either client cannot deploy, independent verification fails, or
  owned-resource cleanup fails.

## Results and acceptance criteria

The uploaded artifact contains the Markdown and JSON comparison reports. The job
summary also includes the Markdown report when one was generated. Provisioning,
hosted compute, model calls, and judging incur costs in the configured Azure,
Copilot, and Claude accounts.

Before enabling regular manual use, demonstrate:

- A fresh runner authenticates to Azure through OIDC and resolves the expected
  enabled default subscription.
- Invalid credentials, denied models, execution errors, and failed independent
  deployment verification produce visible job failures.
- Results remain available after evaluation failures; sensitive auth files are
  excluded.
- Live mode independently verifies the greeting and confirms both owned groups
  are deleted.
- Existing Copilot nightly behavior is unchanged.

Publish the executor, tests, and reporting changes needed by CI. The new
`workflow_dispatch` workflow must exist on the default branch to be manually
triggerable through GitHub Actions; selected execution refs must contain the
required implementation.

## References

- [Existing integration workflow](.github/workflows/test-all-integration.yml)
- [Claude authentication and precedence](https://code.claude.com/docs/en/authentication)
- [Anthropic workload identity federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)
- [Federation configuration reference](https://platform.claude.com/docs/en/manage-claude/wif-reference)
