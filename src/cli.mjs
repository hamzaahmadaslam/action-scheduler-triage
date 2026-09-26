#!/usr/bin/env node
// Entry point for the action-scheduler-triage command. Errors are printed as one line, never as a stack trace.
import { run } from "./main.mjs";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0); // the reader (for example `head`) closed the pipe
});

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`action-scheduler-triage: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  },
);
