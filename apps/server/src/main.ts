import { createGate } from "@kagi/core";
import { createKagiApp } from "@kagi/server";
import { loadConfig } from "./config.ts";

const config = loadConfig(process.env);

// createGate validates every door against its driver, so bad config fails here, not at the door.
const gate = createGate({ doors: config.doors, drivers: config.drivers, authorizer: config.authorizer });

const app = createKagiApp({
  gate,
  authenticator: config.authenticator,
  ...(config.api && { api: config.api }),
  publicOrigin: config.publicOrigin,
  messages: config.messages,
});

// Explicit Bun.serve (not `export default`) so the --compile'd binary serves too.
Bun.serve({ port: config.port, fetch: app.fetch });
console.log(
  JSON.stringify({ msg: "kagi listening", port: config.port, doors: config.doors.map((d) => d.id), api: Boolean(config.api) }),
);
