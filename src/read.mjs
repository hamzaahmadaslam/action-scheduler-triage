// Reads Action Scheduler exports: the JSON that `wp action-scheduler action list --format=json` prints (a list of
// actions), or one action from `wp action-scheduler action get <id> --format=json`. Fields, as Action Scheduler's
// WP-CLI commands name them: id, hook, status, group, recurring ("yes" or "no"), scheduled_date
// ("2026-09-20 03:12:05 +0000"), args (a list or an object) and log_entries (a list of { date, message }).
// Only `hook` is required. Lines that WP-CLI or PHP print before the JSON (notices, warnings) are skipped.
import { readFile } from "node:fs/promises";

/** Reads a file, or standard input when the name is "-". */
export async function readText(name, stdin) {
  if (name !== "-") return readFile(name, "utf8");
  let text = "";
  stdin.setEncoding?.("utf8");
  for await (const chunk of stdin) text += chunk;
  return text;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;

/** A date from an export as milliseconds since 1970, or null. Dates without an offset are read as UTC. */
export function parseDate(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string") return null;
  const m = DATE.exec(value.trim());
  if (!m || m[1] === "0000") return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (zone && /^[+-]/.test(zone)) {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.replace(/\D/g, "");
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return Number.isFinite(ms) ? ms : null;
}

function maybeJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!/^[[{]/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function readLogs(value) {
  const logs = maybeJson(value);
  if (!Array.isArray(logs)) return [];
  return logs
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({ time: parseDate(entry.date), message: typeof entry.message === "string" ? entry.message : String(entry.message ?? "") }));
}

/** An action id as a number when it is one (WP-CLI prints numbers), otherwise as text; null when missing. */
function readId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  const text = String(value).trim();
  return /^\d{1,15}$/.test(text) ? Number(text) : text;
}

function readRecurring(value) {
  if (value === true || value === "yes" || value === "1" || value === 1) return true;
  if (value === false || value === "no" || value === "0" || value === 0) return false;
  return null;
}

/** One action in the form the rest of the tool uses, or null when the entry has no hook. */
export function normalizeAction(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (typeof item.hook !== "string" || !item.hook.trim()) return null;
  const status = typeof item.status === "string" && item.status.trim() ? item.status.trim().toLowerCase() : null;
  const args = maybeJson(item.args);
  return {
    id: readId(item.id ?? item.action_id),
    hook: item.hook.trim(),
    status,
    group: typeof item.group === "string" ? item.group.trim() : "",
    recurring: readRecurring(item.recurring),
    scheduled: parseDate(item.scheduled_date),
    args: args === undefined ? [] : args,
    logs: readLogs(item.log_entries),
  };
}

/** The JSON value in a file, skipping any lines printed before it. Throws an Error that says what is wrong. */
export function parseJson(text) {
  const body = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/^\s*[[{]/m);
    const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        // reported below; the parser's own message quotes the file, which may hold customer data
      }
    }
    if (!body.trim()) throw new Error("the file is empty");
    throw new Error("not valid JSON; export with --format=json");
  }
}

/** The actions in one export's text. */
export function actionsIn(text) {
  const data = parseJson(text);
  const list = Array.isArray(data) ? data : data && typeof data === "object" && typeof data.hook === "string" ? [data] : null;
  if (!list) throw new Error("expected a JSON list of actions, as `wp action-scheduler action list --format=json` prints");
  let invalid = 0;
  const actions = [];
  for (const item of list) {
    const action = normalizeAction(item);
    if (action) actions.push(action);
    else invalid++;
  }
  return { actions, invalid };
}

/**
 * Reads every input (files, or "-" for standard input) and returns the actions once each (an id seen twice is
 * counted once), with counts of what was read. Throws { file, message } for an input that cannot be read.
 */
export async function readActions(names, stdin) {
  const seen = new Set();
  const actions = [];
  const stats = { files: names.length, entries: 0, invalid: 0, duplicates: 0 };
  for (const name of names) {
    let parsed;
    try {
      parsed = actionsIn(await readText(name, stdin));
    } catch (error) {
      throw Object.assign(new Error(error.message), { file: name, code: error.code });
    }
    stats.invalid += parsed.invalid;
    for (const action of parsed.actions) {
      stats.entries++;
      if (action.id !== null) {
        const key = String(action.id);
        if (seen.has(key)) {
          stats.duplicates++;
          continue;
        }
        seen.add(key);
      }
      action.order = actions.length;
      actions.push(action);
    }
  }
  return { actions, stats };
}
