// Drive a real lock from the terminal, through the same Gate the web app uses.
//
//   bun run probe sesame state|unlock|lock|history
//   bun run probe switchbot devices|state|unlock|lock
//
// Credentials come from env (Bun loads .env automatically); see .env.example.

import { createGate, type CommandContext, type LockDriver } from "@kagi/core";
import { fetchHistory, sesameDriver } from "@kagi/driver-sesame";
import { SwitchBotClient, switchbotDriver } from "@kagi/driver-switchbot";

const [vendor, action] = process.argv.slice(2);

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name} (see .env.example)`);
    process.exit(2);
  }
  return v;
}

let driver: LockDriver;
let device: unknown;
if (vendor === "sesame") {
  if (action === "history") {
    console.table(await fetchHistory({ apiKey: env("SESAME_API_KEY") }, env("SESAME_UUID")));
    process.exit(0);
  }
  driver = sesameDriver({ apiKey: env("SESAME_API_KEY") }) as LockDriver;
  device = { uuid: env("SESAME_UUID"), secretKey: env("SESAME_SECRET_KEY") };
} else if (vendor === "switchbot") {
  const creds = { token: env("SWITCHBOT_TOKEN"), secret: env("SWITCHBOT_SECRET") };
  if (action === "devices") {
    const res = await new SwitchBotClient(creds).listDevices();
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
  driver = switchbotDriver(creds) as LockDriver;
  device = { deviceId: env("SWITCHBOT_DEVICE_ID") };
} else {
  console.error("usage: bun run probe <sesame|switchbot> <state|unlock|lock|history|devices>");
  process.exit(2);
}

const parsed = driver.parseDevice(device);
const ctx: CommandContext = {
  actor: { id: "probe", displayName: process.env.KAGI_PROBE_NAME ?? "KAGI probe" },
  requestId: crypto.randomUUID(),
  signal: AbortSignal.timeout(10_000),
};

switch (action) {
  case "state":
    console.log(await driver.getState?.(parsed, ctx));
    break;
  case "lock":
    console.log(await driver.lock?.(parsed, ctx));
    break;
  case "unlock": {
    const gate = createGate({
      doors: [{ id: "probe", name: "probe", driver: vendor, device }],
      drivers: { [vendor]: driver },
      authorizer: { authorize: async () => ({ allow: true }) },
    });
    const principal = { id: "probe", displayName: ctx.actor.displayName, claims: {} };
    console.log(await gate.unlock({ principal, doorId: "probe" }));
    break;
  }
  default:
    console.error("usage: bun run probe <sesame|switchbot> <state|unlock|lock|history|devices>");
    process.exit(2);
}
