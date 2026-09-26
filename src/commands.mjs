// The WP-CLI commands the report prints for an admin to run by hand. This tool never runs them.
//
// Action Scheduler will not run a failed action again: its runner skips any action that is not pending
// (ActionScheduler_Abstract_QueueRunner::process_action), so `wp action-scheduler action run <id>` does nothing for
// a failed one. Running the work again means a new action with the same hook, arguments and group:
//   wp action-scheduler action create <hook> async --args='<json>' --group=<group>
// The arguments are copied exactly as exported, because a masked value would run the action with the wrong data.
// Commands are quoted for a POSIX shell (bash, zsh, sh), as used over SSH.

const SAFE = /^[A-Za-z0-9_\-./:=@%+,]+$/;
// Characters that JSON.stringify leaves as they are but a terminal can act on: DEL, the C1 range, zero-width and
// text-direction marks, and line and paragraph separators. Escaping them keeps the JSON identical once decoded.
const char = (code) => String.fromCharCode(code);
const UNSAFE_IN_JSON = new RegExp(`[\\x7f-\\x9f${char(0x200b)}-${char(0x200f)}${char(0x2028)}${char(0x2029)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}${char(0xfeff)}]`, "g");
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${char(0x200b)}-${char(0x200f)}${char(0x2028)}${char(0x2029)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}${char(0xfeff)}]`);

/** Quotes a value for a POSIX shell: single quotes, with any single quote written as '\''. */
export function shellQuote(value) {
  const text = String(value);
  if (SAFE.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The arguments as JSON, with characters a terminal could act on written as \u escapes. */
export function argsJson(args) {
  return JSON.stringify(args).replace(UNSAFE_IN_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Why the arguments cannot be copied exactly into a command, or null when they can. */
function copyProblem(value, depth = 0) {
  if (depth > 64) return "the arguments are nested too deeply";
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value) ? "an argument is a number too large to copy exactly" : null;
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = copyProblem(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  // JavaScript puts keys that look like array indexes first, which can change the order of numbered keys; the
  // callback receives the argument values in order, so such arguments are not copied.
  if (Object.keys(value).some((key) => /^(0|[1-9]\d*)$/.test(key))) return "the arguments have numbered keys, whose order cannot be kept";
  for (const item of Object.values(value)) {
    const problem = copyProblem(item, depth + 1);
    if (problem) return problem;
  }
  return null;
}

/**
 * The command that queues one failed action again, unchanged: { command } or { reason } when it cannot be written
 * safely. The new action gets Action Scheduler's default priority (10).
 */
export function retryCommand(action) {
  if (CONTROL.test(action.hook) || CONTROL.test(action.group ?? "")) return { reason: "the hook or group name holds control characters" };
  // WP-CLI would read a hook that starts with a dash as an option, such as --require=<file>.
  if (action.hook.startsWith("-")) return { reason: "the hook name starts with a dash" };
  const { args } = action;
  if (args === null || typeof args !== "object") return { reason: "the export holds no argument list for this action" };
  const problem = copyProblem(args);
  if (problem) return { reason: problem };
  const parts = ["wp", "action-scheduler", "action", "create", shellQuote(action.hook), "async"];
  const empty = Array.isArray(args) ? args.length === 0 : Object.keys(args).length === 0;
  if (!empty) parts.push(`--args=${shellQuote(argsJson(args))}`);
  if (action.group) parts.push(`--group=${shellQuote(action.group)}`);
  return { command: parts.join(" ") };
}

/**
 * The retry commands for a group judged safe to retry: { commands, notCopied }. Recurring actions get none: the
 * next scheduled run repeats their work, and an extra one-off copy would not restore a stopped schedule.
 */
export function commandsFor(group) {
  const commands = [];
  const notCopied = [];
  for (const action of group.actions) {
    if (action.recurring === true) continue;
    const result = retryCommand(action);
    if (result.command) commands.push(result.command);
    else notCopied.push({ id: action.id, reason: result.reason });
  }
  return { commands, notCopied };
}

/** A read-only command that lists the pending instances of a recurring hook. */
export function pendingListCommand(hook) {
  if (CONTROL.test(hook)) return null;
  return `wp action-scheduler action list --hook=${shellQuote(hook)} --status=pending --fields=id,scheduled_date`;
}

/** The command that runs the due pending actions of one hook now, or null when the hook cannot be named safely. */
export function runHookCommand(hook) {
  if (CONTROL.test(hook) || hook.includes(",")) return null; // --hooks takes a comma-separated list
  return `wp action-scheduler run --hooks=${shellQuote(hook)}`;
}
