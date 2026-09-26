// Runs the command in-process with captured output, a chosen environment and a fixture fetch.
import { run } from "../../src/main.mjs";

export async function runCli(args, { env = {}, fetchImpl, jev, stdin } = {}) {
  let out = "";
  let err = "";
  const code = await run(args, {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    env,
    fetchImpl,
    jev,
    stdin,
  });
  return { code, out, err };
}

export const KEY_ENV = { TYPESAFE_API_KEY: "test-secret-value" };
