import { expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const base = {
  KAGI_PUBLIC_ORIGIN: "https://door.example.com/",
  KAGI_DOORS: JSON.stringify([{ id: "home", name: "Home", driver: "sesame", device: {} }]),
  CLERK_SECRET_KEY: "sk_test_x",
  CLERK_PUBLISHABLE_KEY: "pk_test_x",
  SESAME_API_KEY: "k",
};

test("loads a minimal SESAME setup", () => {
  const c = loadConfig(base);
  expect(c.publicOrigin).toBe("https://door.example.com");
  expect(Object.keys(c.drivers)).toEqual(["sesame"]);
  expect(c.port).toBe(8080);
  expect(c.messages.lang).toBe("en");
});

test("fails loudly on missing or malformed settings", () => {
  expect(() => loadConfig({ ...base, CLERK_SECRET_KEY: undefined })).toThrow(/CLERK_SECRET_KEY/);
  expect(() => loadConfig({ ...base, KAGI_DOORS: "{" })).toThrow(/not valid JSON/);
  expect(() => loadConfig({ ...base, SWITCHBOT_TOKEN: "t" })).toThrow(/SWITCHBOT_SECRET/);
});
