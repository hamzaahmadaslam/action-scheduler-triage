// The command: reads the options and the exports, groups the actions, asks Jev (unless --dry-run), and prints the
// report. run() returns the exit code and takes its streams, environment and fetch from `io`, so tests can run it
// in-process without a key or a network. The tool only reads files and prints; it never runs WP-CLI and never
// touches a database.
import { parseArgs } from "node:util";
import { groupActions } from "./group.mjs";
import { DEFAULT_MODEL, JevError } from "./jev.mjs";
import { planRequests } from "./questions.mjs";
import { readActions } from "./read.mjs";
import { VERSION, dryRunJson, dryRunText, reportJson, reportText } from "./report.mjs";
import { DEFAULT_THRESHOLD, rank, triage } from "./triage.mjs";

export const USAGE = `Usage: action-scheduler-triage <export.json | -> [more exports] [options]

Groups failed Action Scheduler actions by hook and error, asks Jev (TypeSafe) what caused each group, whether it
is safe to run again unchanged and how urgent it is, and prints the groups to retry (with WP-CLI commands to run
by hand), the groups to fix first, and the groups to review. It never runs a command itself.

Export the failed actions with WP-CLI (Action Scheduler 3.9.1 or later):
  wp action-scheduler action list --status=failed --orderby=modified --order=DESC --per_page=1000 \\
    --fields=id,hook,status,group,recurring,scheduled_date,args,log_entries --format=json > failed.json

Options:
  --json             print JSON instead of the text report
  --threshold <p>    confidence from 0.5 to 1 below which a group goes to review (default ${DEFAULT_THRESHOLD})
  --batch <n>        send at most n groups per request (default: as many as fit the token budget)
  --dry-run          group the actions and print the questions and a token estimate; nothing is sent
  -h, --help         show this help
  -v, --version      show the version

Environment:
  TYPESAFE_API_KEY   your TypeSafe key (not needed for --dry-run)
  TYPESAFE_MODEL     the model to ask (default ${DEFAULT_MODEL})

Use - to read an export from standard input. Exit codes: 0 done, 1 TypeSafe error, 2 bad options or input.
`;

const MISSING_KEY =
  "TYPESAFE_API_KEY is not set. Get a key at https://typesafe.ai and export it first, or use --dry-run to see what would be sent.\n";

const OPTIONS = {
  json: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  threshold: { type: "string" },
  batch: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
};

/** Parsed options, or an Error whose message says what is wrong. */
export function readOptions(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  if (values.help || values.version) return { help: values.help, version: values.version };
  if (!positionals.length) throw new Error("Give the path to an export (JSON from wp action-scheduler action list), or - to read standard input.");
  if (positionals.filter((name) => name === "-").length > 1) throw new Error("Standard input (-) can be read only once.");
  const threshold = values.threshold === undefined ? DEFAULT_THRESHOLD : Number(values.threshold);
  if (values.threshold !== undefined && (values.threshold.trim() === "" || !(threshold >= 0.5 && threshold <= 1))) {
    throw new Error("--threshold must be a number from 0.5 to 1.");
  }
  let batch = null;
  if (values.batch !== undefined) {
    batch = Number(values.batch);
    if (!Number.isInteger(batch) || batch < 1) throw new Error("--batch must be a whole number above 0.");
  }
  return { files: positionals, json: values.json, dryRun: values["dry-run"], threshold, batch };
}

function readProblem(error) {
  if (error?.code === "ENOENT") return "no such file";
  if (error?.code === "EISDIR") return "it is a folder, not a file";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission denied";
  return error?.message ?? String(error);
}

export async function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  let options;
  try {
    options = readOptions(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (options.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!options.dryRun && !apiKey) {
    stderr.write(MISSING_KEY);
    return 2;
  }

  let read;
  try {
    read = await readActions(options.files, io.stdin ?? process.stdin);
  } catch (error) {
    stderr.write(`Cannot read ${error.file ?? "the input"}: ${readProblem(error)}\n`);
    return 2;
  }

  const grouped = groupActions(read.actions);
  const model = env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL;
  const requests = planRequests(grouped.failed, grouped.stats.last, { maxGroups: options.batch ?? Infinity });
  const meta = { files: options.files, model, threshold: options.threshold };
  if (options.dryRun) {
    stdout.write(options.json ? dryRunJson(read, grouped, requests, meta) : dryRunText(read, grouped, requests, meta));
    return 0;
  }

  let outcome = { model: null, usage: { input_tokens: 0, output_tokens: 0 }, requests: 0 };
  if (requests.length) {
    try {
      outcome = await triage(grouped.failed, requests, {
        threshold: options.threshold,
        apiKey,
        model,
        fetchImpl: io.fetchImpl ?? globalThis.fetch,
        ...io.jev,
      });
    } catch (error) {
      if (error instanceof JevError) {
        stderr.write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }
  const ranked = rank(grouped.failed);
  stdout.write(options.json ? reportJson(read, grouped, outcome, ranked, meta) : reportText(read, grouped, outcome, ranked, meta));
  return 0;
}
