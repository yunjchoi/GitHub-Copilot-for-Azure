import { readFileSync, writeFileSync } from "node:fs";

const configuration = JSON.parse(
  readFileSync(new URL("./cosmos-config.json", import.meta.url), "utf8"),
);
const names = ["COSMOS_ENDPOINT", "COSMOS_DATABASE", "COSMOS_CONTAINER"];
const values = names.map((name) => {
  const value = typeof configuration[name] === "string" ? configuration[name].trim() : "";
  if (!value || /[\r\n"]/.test(value)) {
    throw new Error(
      `Set ${name} in cosmos-config.json before running this eval. ` +
      "No Cosmos resources will be provisioned by this fixture.",
    );
  }
  return value;
});

const endpoint = new URL(values[0]);
if (
  endpoint.protocol !== "https:" ||
  !endpoint.hostname.endsWith(".documents.azure.com") ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
) {
  throw new Error("COSMOS_ENDPOINT must be an existing Azure Cosmos DB HTTPS endpoint.");
}

writeFileSync(
  "app/.env",
  names.map((name, index) => `${name}="${values[index]}"`).join("\n") + "\n",
  { mode: 0o600 },
);
