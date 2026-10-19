import { randomUUID } from "node:crypto";

export type CosmosTarget = {
  subscription: string;
  resourceGroup: string;
  account: string;
  database: string;
  container: string;
  location: string;
};

export type DeploymentContext = {
  runId: string;
  subscription: string;
  resourceGroup: string;
  environmentName: string;
  location: string;
  identityName: string;
  identityResourceId: string;
  clientId?: string;
  principalId?: string;
  roleAssignmentId: string;
};

type RoleAssignment = {
  id: string;
  principalId: string;
  roleDefinitionId: string;
  scope: string;
};

export type IsolationDependencies = {
  az: (args: string[]) => string;
  record: (context: DeploymentContext) => void;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_TAG = "ExecutorComparisonRun";
const ROLE_ASSIGNMENT_ATTEMPTS = 6;

function isPrincipalNotFound(error: unknown, principalId: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const stderr = "stderr" in error ? error.stderr : undefined;
  const detail = typeof stderr === "string"
    ? stderr
    : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : error.message;
  return new RegExp(
    `provided principal ID\\s*\\[${principalId}\\]\\s*was not found in the AAD tenant`,
    "i",
  ).test(detail);
}

function roleSnapshot(assignments: RoleAssignment[]): string {
  return JSON.stringify(assignments.map(({ id, principalId, roleDefinitionId, scope }) => ({
    id, principalId, roleDefinitionId, scope,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

export async function withIsolatedDeployment(
  target: CosmosTarget,
  dependencies: IsolationDependencies,
  run: (context: DeploymentContext) => Promise<void>,
): Promise<void> {
  if (!GUID.test(target.subscription) ||
    ![target.resourceGroup, target.account, target.database, target.container, target.location]
      .every(value => /^[a-z0-9_-]+$/i.test(value))) {
    throw new Error("Invalid comparison target identifiers.");
  }
  const { az, record } = dependencies;
  const runId = randomUUID();
  const suffix = runId.replaceAll("-", "").slice(0, 16);
  const resourceGroup = `rg-flask-eval-${suffix}`;
  const identityName = `id-flask-eval-${suffix}`;
  const context: DeploymentContext = {
    runId,
    subscription: target.subscription,
    resourceGroup,
    environmentName: `flask-eval-${suffix}`,
    location: target.location,
    identityName,
    identityResourceId: `/subscriptions/${target.subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${identityName}`,
    roleAssignmentId: randomUUID(),
  };
  const call = (args: string[]) => az([
    ...args, "--subscription", target.subscription, "--only-show-errors",
  ]);
  const cosmosArgs = ["--account-name", target.account, "--resource-group", target.resourceGroup];
  const listRoles = () => JSON.parse(call([
    "cosmosdb", "sql", "role", "assignment", "list", ...cosmosArgs, "-o", "json",
  ])) as RoleAssignment[];
  const listGroups = () => JSON.parse(call([
    "group", "list", "--query", "[].name", "-o", "json",
  ])) as string[];
  const baselineRoles = listRoles();
  const baselineGroups = listGroups();
  if (baselineGroups.some(name => name.toLowerCase() === resourceGroup.toLowerCase())) {
    throw new Error(`Refusing to reuse existing resource group ${resourceGroup}.`);
  }
  record(context);

  const errors: unknown[] = [];
  let groupAttempted = false;
  try {
    groupAttempted = true;
    call([
      "group", "create", "--name", resourceGroup, "--location", target.location,
      "--tags", `${OWNER_TAG}=${runId}`, "-o", "none",
    ]);
    const identity = JSON.parse(call([
      "identity", "create", "--name", identityName, "--resource-group", resourceGroup,
      "--location", target.location, "-o", "json",
    ])) as { clientId: string; principalId: string };
    if (!GUID.test(identity.clientId) || !GUID.test(identity.principalId)) {
      throw new Error("Azure returned an invalid managed identity.");
    }
    context.clientId = identity.clientId;
    context.principalId = identity.principalId;
    record(context);
    const roleArgs = [
      "cosmosdb", "sql", "role", "assignment", "create", ...cosmosArgs,
      "--role-assignment-id", context.roleAssignmentId,
      "--principal-id", identity.principalId,
      "--role-definition-id", "00000000-0000-0000-0000-000000000001",
      "--scope", `/dbs/${target.database}/colls/${target.container}`, "-o", "none",
    ];
    for (let attempt = 1; attempt <= ROLE_ASSIGNMENT_ATTEMPTS; attempt++) {
      try {
        call(roleArgs);
        break;
      } catch (error) {
        if (attempt === ROLE_ASSIGNMENT_ATTEMPTS || !isPrincipalNotFound(error, identity.principalId)) {
          throw error;
        }
        const waitMs = Math.min(10_000 * 2 ** (attempt - 1), 60_000);
        console.warn(
          `Cosmos DB cannot resolve trial principal ${identity.principalId} yet ` +
          `(attempt ${attempt}/${ROLE_ASSIGNMENT_ATTEMPTS}); retrying the same role assignment in ${waitMs / 1000}s.`,
        );
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    await run(context);
  } catch (error) {
    errors.push(error);
  } finally {
    cleanup();
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Comparison run or cleanup failed; stopping before the next executor.");
  }

  function cleanup(): void {
    // Remove only assignments owned by this run's identity; never sweep the account.
    try {
      if (context.principalId) {
        const existingIds = new Set(baselineRoles.map(role => role.id.toLowerCase()));
        for (const role of listRoles()) {
          if (role.principalId.toLowerCase() !== context.principalId.toLowerCase() ||
            existingIds.has(role.id.toLowerCase())) {
            continue;
          }
          const id = role.id.split("/").at(-1) ?? "";
          const accountId = `/subscriptions/${target.subscription}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DocumentDB/databaseAccounts/${target.account}`;
          if (!GUID.test(id) ||
            role.id.toLowerCase() !== `${accountId}/sqlRoleAssignments/${id}`.toLowerCase()) {
            throw new Error(`Refusing to delete unexpected role assignment ${role.id}.`);
          }
          call([
            "cosmosdb", "sql", "role", "assignment", "delete", ...cosmosArgs,
            "--role-assignment-id", id, "--yes", "-o", "none",
          ]);
        }
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (groupAttempted && call([
        "group", "exists", "--name", resourceGroup, "-o", "tsv",
      ]) === "true") {
        const owner = call([
          "group", "show", "--name", resourceGroup, "--query", `tags.${OWNER_TAG}`, "-o", "tsv",
        ]);
        if (resourceGroup === target.resourceGroup || owner !== runId) {
          throw new Error(`Refusing cleanup: resource group ${resourceGroup} has no matching ownership tag.`);
        }
        // Deliberately wait for deletion before permitting another executor to start.
        call(["group", "delete", "--name", resourceGroup, "--yes", "-o", "none"]);
      }
      if (call(["group", "exists", "--name", resourceGroup, "-o", "tsv"]) !== "false") {
        throw new Error(`Cleanup incomplete: resource group ${resourceGroup} still exists.`);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (roleSnapshot(listRoles()) !== roleSnapshot(baselineRoles)) {
        throw new Error("Cosmos role assignments differ from the pre-run snapshot. Stop and review; no further executor may run.");
      }
      const unexpectedGroups = listGroups().filter(name =>
        !baselineGroups.some(previous => previous.toLowerCase() === name.toLowerCase()));
      if (unexpectedGroups.length > 0) {
        throw new Error(`Unexpected resource groups remain: ${unexpectedGroups.join(", ")}. Review manually; they will not be deleted automatically.`);
      }
    } catch (error) {
      errors.push(error);
    }
  }
}
