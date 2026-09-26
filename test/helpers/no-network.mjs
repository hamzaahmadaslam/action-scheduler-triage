// Imported first by every test file. Replaces fetch so that any request not routed through a fixture fails the
// test instead of reaching the network, records the attempt, and fails the file at the end if there was one.
import { after } from "node:test";

export const blocked = [];

globalThis.fetch = async (url) => {
  blocked.push(String(url));
  throw new Error(`network access is blocked in tests: ${url}`);
};

after(() => {
  if (blocked.length) throw new Error(`a test tried to reach the network: ${blocked.join(", ")}`);
});
