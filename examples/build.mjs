// Rebuilds the example outputs (npm run example) from the example exports and the fixture answers. It needs no key
// and makes no network request: the fixture in fixture.mjs stands in for Jev.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OUTPUTS, exampleOutput } from "./fixture.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
for (const [name, args] of Object.entries(OUTPUTS)) {
  writeFileSync(new URL(name, import.meta.url), await exampleOutput(args));
  console.log(`wrote examples/${name}`);
}
