import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  withIsolatedDeployment,
  type CosmosTarget,
  type DeploymentContext,
} from "./isolated-deployment.ts";

const target: CosmosTarget = {
  subscription: "11111111-1111-1111-1111-111111111111",
  resourceGroup: "existing-cosmos-group",
  account: "existing-account",
  database: "LegoDatabase",
  container: "legoSets",
  location: "eastus2",
};
const principalId = "22222222-2222-2222-2222-222222222222";
const clientId = "33333333-3333-3333-3333-333333333333";
const accountId = `/subscriptions/${target.subscription}/resourceGroups/${target.resourceGroup}/providers/Microsoft.DocumentDB/databaseAccounts/${target.account}`;
const originalRole = {
  id: `${accountId}/sqlRoleAssignments/44444444-4444-4444-4444-444444444444`,
  principalId: "55555555-5555-5555-5555-555555555555",
  roleDefinitionId: "existing-reader",
  scope: "/",
};

function fixture() {
  const groups = new Map<string, string>([[target.resourceGroup, "unrelated-owner"]]);
  const roles = [{ ...originalRole }];
  let context: DeploymentContext;
  const record = vi.fn((value: DeploymentContext) => { context = structuredClone(value); });
  const value = (args: string[], key: string) => args[args.indexOf(key) + 1];
  const az = vi.fn((args: string[]) => {
    expect(value(args, "--subscription")).toBe(target.subscription);
    const command = args.slice(0, 5).join(" ");
    if (command.startsWith("cosmosdb sql role assignment list")) {
      return JSON.stringify(roles);
    }
    if (command.startsWith("cosmosdb sql role assignment create")) {
      roles.push({
        id: `${accountId}/sqlRoleAssignments/${value(args, "--role-assignment-id")}`,
        principalId: value(args, "--principal-id"),
        roleDefinitionId: value(args, "--role-definition-id"),
        scope: value(args, "--scope"),
      });
      return "";
    }
    if (command.startsWith("cosmosdb sql role assignment delete")) {
      const id = value(args, "--role-assignment-id");
      const index = roles.findIndex(role => role.id.endsWith(id));
      if (index < 0) throw new Error("Missing role assignment.");
      roles.splice(index, 1);
      return "";
    }
    if (args[0] === "group") {
      const name = value(args, "--name");
      switch (args[1]) {
        case "list": return JSON.stringify([...groups.keys()]);
        case "create":
          groups.set(name, value(args, "--tags").split("=")[1]);
          return "";
        case "exists": return String(groups.has(name));
        case "show": return groups.get(name) ?? "";
        case "delete":
          groups.delete(name);
          return "";
      }
    }
    if (args[0] === "identity" && args[1] === "create") {
      return JSON.stringify({ clientId, principalId });
    }
    throw new Error(`Unexpected Azure operation: ${args.join(" ")}`);
  });
  return { az, record, roles, groups, context: () => context };
}

describe("isolated executor deployments", () => {
  test("uses a fresh identity and scope, then restores Azure state before another run", async () => {
    const state = fixture();
    const contexts: DeploymentContext[] = [];
    for (let i = 0; i < 2; i++) {
      await withIsolatedDeployment(target, state, async context => {
        expect(state.groups.size).toBe(2);
        expect(state.roles).toHaveLength(2);
        expect(state.roles[1]).toMatchObject({
          principalId, scope: "/dbs/LegoDatabase/colls/legoSets",
          roleDefinitionId: "00000000-0000-0000-0000-000000000001",
        });
        contexts.push(context);
      });
      expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
      expect(state.roles).toEqual([originalRole]);
    }
    expect(contexts[0].resourceGroup).not.toBe(contexts[1].resourceGroup);
    expect(contexts[0].environmentName).not.toBe(contexts[1].environmentName);
    const deletes = state.az.mock.calls.map(([args]) => args).filter(args => args[1] === "delete");
    expect(deletes).toHaveLength(2);
    expect(deletes.every(args => !args.includes("--no-wait"))).toBe(true);
    expect(deletes.every(args => !args.includes(target.resourceGroup))).toBe(true);
  });

  test("cleans up when agent execution or grading fails", async () => {
    const state = fixture();
    await expect(withIsolatedDeployment(target, state, async () => {
      throw new Error("Agent/grader failed.");
    })).rejects.toThrow("stopping before the next executor");
    expect(state.roles).toEqual([originalRole]);
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
  });

  test("cleans up partially successful provisioning without running an agent", async () => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    state.az.mockImplementation(args => {
      const result = originalAz(args);
      if (args.slice(0, 5).join(" ") === "cosmosdb sql role assignment create") {
        throw new Error("Role creation response was lost.");
      }
      return result;
    });
    const run = vi.fn(async () => {});
    await expect(withIsolatedDeployment(target, state, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(state.roles).toEqual([originalRole]);
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
  });

  test("refuses deletion when the resource group ownership tag changed", async () => {
    const state = fixture();
    await expect(withIsolatedDeployment(target, state, async context => {
      state.groups.set(context.resourceGroup, "someone-else");
    })).rejects.toThrow();
    expect(state.groups.has(state.context().resourceGroup)).toBe(true);
    expect(state.az.mock.calls.some(([args]) => args[0] === "group" && args[1] === "delete")).toBe(false);
    expect(state.roles).toEqual([originalRole]);
  });

  test("blocks a subsequent executor on deletion failure and still attempts group cleanup", async () => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    state.az.mockImplementation(args => {
      if (args.slice(0, 5).join(" ") === "cosmosdb sql role assignment delete") {
        throw new Error("Role deletion denied.");
      }
      return originalAz(args);
    });
    const second = vi.fn();
    await expect((async () => {
      await withIsolatedDeployment(target, state, async () => {});
      second();
    })()).rejects.toThrow();
    expect(second).not.toHaveBeenCalled();
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
    expect(state.roles).toHaveLength(2);
  });

  test("refuses a clean-slate claim while group deletion is still pending", async () => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    state.az.mockImplementation(args => args[0] === "group" && args[1] === "delete" ? "" : originalAz(args));
    await expect(withIsolatedDeployment(target, state, async () => {})).rejects.toThrow();
    expect(state.groups.size).toBe(2);
  });

  test("detects unrelated Cosmos role changes and leaked groups without deleting them", async () => {
    const state = fixture();
    await expect(withIsolatedDeployment(target, state, async () => {
      state.roles[0].scope = "/dbs/changed";
      state.groups.set("unexpected-group", "not-ours");
    })).rejects.toThrow();
    expect(state.roles[0].scope).toBe("/dbs/changed");
    expect(state.groups.has("unexpected-group")).toBe(true);
  });

  test("cleans additional assignments only for the trial identity", async () => {
    const state = fixture();
    const otherRole = {
      ...originalRole,
      id: `${accountId}/sqlRoleAssignments/66666666-6666-6666-6666-666666666666`,
    };
    await expect(withIsolatedDeployment(target, state, async () => {
      state.roles.push(
        {
          ...originalRole,
          id: `${accountId}/sqlRoleAssignments/77777777-7777-7777-7777-777777777777`,
          principalId,
        },
        otherRole,
      );
    })).rejects.toThrow();
    expect(state.roles).toEqual([originalRole, otherRole]);
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
  });

  test("cleans a group when its creation succeeds but the CLI reports failure", async () => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    state.az.mockImplementation(args => {
      const result = originalAz(args);
      if (args[0] === "group" && args[1] === "create") {
        throw new Error("Group create response was lost.");
      }
      return result;
    });
    const run = vi.fn(async () => {});
    await expect(withIsolatedDeployment(target, state, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
    expect(state.roles).toEqual([originalRole]);
  });

  test("does not provision resources if recovery context cannot be persisted", async () => {
    const state = fixture();
    state.record.mockImplementation(() => { throw new Error("Disk full."); });
    await expect(withIsolatedDeployment(target, state, async () => {})).rejects.toThrow("Disk full");
    expect(state.az.mock.calls.every(([args]) => args.includes("list"))).toBe(true);
  });

  test("rejects malformed identifiers before any Azure command", async () => {
    const state = fixture();
    await expect(withIsolatedDeployment(
      { ...target, subscription: "not-a-subscription" }, state, async () => {},
    )).rejects.toThrow("Invalid comparison target");
    expect(state.az).not.toHaveBeenCalled();
  });
});

describe("Cosmos identity propagation", () => {
  const propagationMessage = `ERROR: (BadRequest) The provided principal ID [${principalId}] ` +
    "was not found in the AAD tenant(s) [66666666-6666-6666-6666-666666666666].";
  const isRoleCreate = (args: string[]) =>
    args.slice(0, 5).join(" ") === "cosmosdb sql role assignment create";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test.each([
    { name: "CLI stderr", error: Object.assign(new Error("Command failed"), { stderr: propagationMessage }) },
    { name: "buffer stderr", error: Object.assign(new Error("Command failed"), { stderr: Buffer.from(propagationMessage) }) },
    { name: "error message", error: new Error(propagationMessage) },
  ])("retries $name with the same identity and assignment, then cleans up", async ({ error }) => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    let attempts = 0;
    state.az.mockImplementation(args => {
      if (isRoleCreate(args) && ++attempts <= 2) {
        throw error;
      }
      return originalAz(args);
    });
    const run = vi.fn(async () => {
      expect(state.roles).toHaveLength(2);
    });
    const completion = withIsolatedDeployment(target, state, run);
    expect(run).not.toHaveBeenCalled();
    await Promise.all([
      expect(completion).resolves.toBeUndefined(),
      vi.runAllTimersAsync(),
    ]);

    const creates = state.az.mock.calls.map(([args]) => args).filter(isRoleCreate);
    expect(creates).toHaveLength(3);
    expect(creates.every(args => JSON.stringify(args) === JSON.stringify(creates[0]))).toBe(true);
    expect(state.az.mock.calls.filter(([args]) => args[0] === "identity" && args[1] === "create")).toHaveLength(1);
    expect(Date.now()).toBe(30_000);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.roles).toEqual([originalRole]);
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
  });

  test("bounds retries and backoff, preserves the final error, and cleans up before stopping", async () => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    const error = Object.assign(new Error("Command failed"), { stderr: propagationMessage });
    state.az.mockImplementation(args => {
      if (isRoleCreate(args)) {
        throw error;
      }
      return originalAz(args);
    });
    const run = vi.fn(async () => {});
    const next = vi.fn();
    const completion = withIsolatedDeployment(target, state, run).then(next);
    await Promise.all([
      expect(completion).rejects.toMatchObject({
        message: "Comparison run or cleanup failed; stopping before the next executor.",
        errors: [error],
      }),
      vi.runAllTimersAsync(),
    ]);

    expect(state.az.mock.calls.filter(([args]) => isRoleCreate(args))).toHaveLength(6);
    expect(Date.now()).toBe(190_000);
    expect(console.warn).toHaveBeenCalledTimes(5);
    expect(run).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(state.roles).toEqual([originalRole]);
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
  });

  test.each([
    { name: "permission denied", error: new Error("AuthorizationFailed: role assignment create denied.") },
    { name: "unrelated not-found error", error: new Error("ResourceNotFound: Cosmos account was not found.") },
    { name: "another principal", error: new Error(propagationMessage.replace(principalId, clientId)) },
    { name: "non-error value", error: propagationMessage },
  ])("fails immediately for $name without retrying", async ({ error }) => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    state.az.mockImplementation(args => {
      if (isRoleCreate(args)) {
        throw error;
      }
      return originalAz(args);
    });
    const run = vi.fn(async () => {});
    await expect(withIsolatedDeployment(target, state, run)).rejects.toMatchObject({ errors: [error] });

    expect(state.az.mock.calls.filter(([args]) => isRoleCreate(args))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(console.warn).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(state.roles).toEqual([originalRole]);
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
  });

  test("does not retry cleanup errors after a successful role retry", async () => {
    const state = fixture();
    const originalAz = state.az.getMockImplementation()!;
    let attempts = 0;
    state.az.mockImplementation(args => {
      if (isRoleCreate(args) && ++attempts === 1) {
        throw new Error(propagationMessage);
      }
      if (args.slice(0, 5).join(" ") === "cosmosdb sql role assignment delete") {
        throw new Error(propagationMessage);
      }
      return originalAz(args);
    });
    const run = vi.fn(async () => {});
    const next = vi.fn();
    const completion = withIsolatedDeployment(target, state, run).then(next);
    await Promise.all([
      expect(completion).rejects.toThrow("stopping before the next executor"),
      vi.runAllTimersAsync(),
    ]);

    expect(attempts).toBe(2);
    expect(state.az.mock.calls.filter(([args]) =>
      args.slice(0, 5).join(" ") === "cosmosdb sql role assignment delete")).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(state.roles).toHaveLength(2);
    expect([...state.groups.keys()]).toEqual([target.resourceGroup]);
  });
});
