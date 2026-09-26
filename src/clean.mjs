// Reads the failure out of an action's log entries and cleans it before it is grouped, shown or sent.
//
// failureOf(): the log message that says why an action failed, found among Action Scheduler's own lifecycle
// messages ("action created", "action started via WP Cron" and the rest).
// cleanMessage(): server paths become relative to the WordPress folder and other paths keep only the file name;
// email addresses, public IP addresses, URL query strings and credentials are replaced; stack traces are cut off.
// templateOf(): dates, ids, amounts, numbers, hashes and quoted values become placeholders, so repeats of one
// error with different data share a group. Error codes and HTTP status codes stay, because they tell causes apart.
import { isIPv4, isIPv6 } from "node:net";

const char = (code) => String.fromCharCode(code);
// Control characters (terminal escape sequences), DEL, the C1 range, zero-width and text-direction marks, line and
// paragraph separators and the byte order mark. Text from an export can hold anything a customer or a remote
// service wrote, so these are removed before anything is printed.
const INVISIBLE_CLASS = `[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${char(0x200b)}-${char(0x200f)}${char(0x2028)}${char(0x2029)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}${char(0xfeff)}]`;
const INVISIBLE = new RegExp(INVISIBLE_CLASS, "g");
const HAS_INVISIBLE = new RegExp(`${INVISIBLE_CLASS}|[\\t\\n]`);

/** Replaces control and invisible characters, tabs and line breaks with spaces. */
export function visible(text) {
  return String(text).replace(INVISIBLE, " ").replace(/[\t\n]/g, " ");
}

/** True when the text holds a control, invisible or line-break character. */
export const hasInvisible = (text) => HAS_INVISIBLE.test(String(text));

// Where a WordPress path starts to mean something. Bedrock keeps plugins and themes under app/.
const MARKER = String.raw`(?:wp-content|wp-includes|wp-admin|app\/(?:plugins|mu-plugins|themes|uploads))\/`;
const ROOT_FILE = String.raw`(?:wp-[a-z-]+|index|xmlrpc)\.php\b`;
// A path starts at the beginning of the text or after a space, bracket, quote, "=" or ",".
const START = String.raw`(?<=^|[\s(\[{'"=,])`;
// Paths that contain spaces are only recognised after " in ", " at ", an opening bracket or a quote.
const OPENER = String.raw`(?<=\b(?:in|at) |[('"])`;
const DRIVE = String.raw`(?:[A-Za-z]:)?`;
const SPACED = String.raw`[^'"()<>:\n]*?`;
const PLAIN = String.raw`[^\s'"()<>:]`;
const BASENAME = String.raw`([^\s'"()<>:/]+\.php)\b`;

const PATH_RULES = [
  [new RegExp(`${OPENER}${DRIVE}\\/${SPACED}\\/(?=${MARKER})`, "g"), ""],
  [new RegExp(`${OPENER}${DRIVE}\\/${SPACED}\\/(?=${ROOT_FILE})`, "g"), ""],
  [new RegExp(`${START}${DRIVE}\\/(?:${PLAIN}*?\\/)?(?=${MARKER})`, "g"), ""],
  [new RegExp(`${START}${DRIVE}\\/(?:${PLAIN}*\\/)?(?=${ROOT_FILE})`, "g"), ""],
  [new RegExp(`${OPENER}${DRIVE}\\/${SPACED}\\/${BASENAME}`, "g"), ".../$1"],
  [new RegExp(`${START}${DRIVE}\\/(?:${PLAIN}*\\/)?${BASENAME}`, "g"), ".../$1"],
];
const WINDOWS_PATH = /[A-Za-z]:\\[^'"()<>\n]*?\.php\b|\\(?:wp-content|wp-includes|wp-admin)\\[^\s'"()<>]*/g;
const URL = /\b(https?|ftps?):\/\/(?:[^\s'"<>()/?#@]+@)?([^\s'"<>()/?#]+)([^\s'"<>()?#]*)(\?[^\s'"<>()#]*)?(#[^\s'"<>()]*)?/gi;
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
const IPV6 = /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g;

/** True for addresses that point at a person or a public server (not loopback, private or link-local). */
export function isPublicIp(address) {
  if (isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (/^fe[89ab]/.test(lower) || /^f[cd]/.test(lower)) return false;
    return true;
  }
  return false;
}

/** Relative WordPress paths and placeholders in place of email addresses, public IPs, queries and credentials. */
export function cleanText(text) {
  let out = visible(text).replace(WINDOWS_PATH, (path) => path.replace(/\\/g, "/"));
  for (const [pattern, replacement] of PATH_RULES) out = out.replace(pattern, replacement);
  out = out
    .replace(URL, (_, scheme, host, path, query) => `${scheme}://${host}${path}${query ? "?<query>" : ""}`)
    .replace(EMAIL, "<email>")
    .replace(IPV4, (ip) => (isPublicIp(ip) ? "<ip>" : ip))
    .replace(IPV6, (ip) => (isPublicIp(ip) ? "<ip>" : ip));
  return out.replace(/\s+/g, " ").trim();
}

const MAX_MESSAGE = 1000; // characters kept of an error message

/** cleanText() of an error, without the stack trace PHP appends to uncaught exceptions. */
export function cleanMessage(message) {
  const cut = String(message).split(/\s*(?:Stack trace:|\n#0 )/)[0];
  const out = cleanText(cut);
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 3)}...` : out;
}

// ---------------------------------------------------------------------------------------------------------------
// The failure in an action's log. The message formats are Action Scheduler's own (ActionScheduler_Logger and
// ActionScheduler_Abstract_QueueRunner); the timeout wording changed in 4.0.0, so both forms are read.

const LIFECYCLE = /^action (?:created|canceled|cancelled|reset|started|complete|completed|ignored)\b/i;
const STOPPED = /^This action appears to be consistently failing/i;
const FAILED = /^action failed(?: via [^:]*)?:\s*([\s\S]*)$/i;
const SHUTDOWN = /^unexpected shutdown:\s*([\s\S]*)$/i;
const TIMED_OUT = /^action (?:was in-progress for at least (\d+) seconds without completing|marked as failed after (\d+) seconds)/i;
const NEXT_INSTANCE = /^There was a failure scheduling the next instance of this action:\s*([\s\S]*)$/i;

/**
 * The failure in an action's log entries, newest first: { kind, text, time, stopped }. `kind` is exception,
 * fatal, timeout, next-instance, logged (any other message) or none; `stopped` is true when Action Scheduler
 * logged that it will not schedule a recurring action again.
 */
export function failureOf(logs) {
  let stopped = false;
  for (let i = logs.length - 1; i >= 0; i--) {
    const { message, time } = logs[i];
    const text = String(message ?? "").trim();
    if (!text) continue;
    if (STOPPED.test(text)) {
      stopped = true;
      continue;
    }
    if (LIFECYCLE.test(text)) continue;
    let m;
    if ((m = FAILED.exec(text))) return { kind: "exception", text: m[1], time, stopped };
    if ((m = SHUTDOWN.exec(text))) return { kind: "fatal", text: m[1], time, stopped };
    if ((m = TIMED_OUT.exec(text))) {
      const seconds = m[1] ?? m[2];
      return { kind: "timeout", text: `Timed out: the action was still running after ${seconds} seconds and Action Scheduler marked it as failed.`, time, stopped };
    }
    if ((m = NEXT_INSTANCE.exec(text))) return { kind: "next-instance", text: `Could not schedule the next instance: ${m[1]}`, time, stopped };
    return { kind: "logged", text, time, stopped };
  }
  return { kind: "none", text: "", time: null, stopped };
}

// ---------------------------------------------------------------------------------------------------------------
// Templates

const DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))?)?\b/g;
const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b/gi;
const CURRENCY = String.raw`(?:USD|EUR|GBP|PKR|INR|AUD|CAD|JPY|CHF|SEK|NOK|DKK|NZD|ZAR|BRL|MXN|AED|SAR)`;
const AMOUNT = new RegExp(
  String.raw`(?:[$€£¥₹]\s?|\b${CURRENCY}\s?)\d[\d,]*(?:\.\d+)?\b|\b\d[\d,]*(?:\.\d+)?\s?(?:${CURRENCY}\b|[€£])`,
  "g",
);
// An opening quote never follows a letter, digit or ")", which keeps "doesn't" out of it.
const QUOTED = /(?<![\w)])(["'])((?:(?!\1)[^\\]|\\.)*)\1/g;
const IDENTIFIER = /^[\w$\\.:\-/[\]>]{1,60}$/;
// A number, with an optional unit written against it ("300s", "512MB"). Numbers in URL paths count ("/orders/1043").
const NUMBER = /(?<![\w<$.\\-])(\d+(?:\.\d+)*)(ms|s|sec|secs|kb|mb|gb|b)?(?![\w>])/gi;
// Words after which a number is a code that tells causes apart: "cURL error 28", "HTTP 429", "status code 401".
const CODE_BEFORE = /(?:\berror|\berrno|\bcode|\bstatus|\bhttp(?:\/[\d.]+)?|\bresponse|\breturned|\bsqlstate\[\w+\])\s*[:#=]?\s*\[?$/i;
const REASON_AFTER =
  /^\s+(?:OK|Created|Accepted|No Content|Moved|Found|Not Modified|Bad Request|Unauthori[sz]ed|Payment Required|Forbidden|Not Found|Method Not Allowed|Not Acceptable|Request Time-?out|Conflict|Gone|Payload Too Large|Unprocessable|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i;
// Words after which a number is a record's id: "order 1043", "Product #5521", "user_id: 7".
const ID_BEFORE =
  /(?:\b(?:order|subscription|user|customer|product|post|item|webhook|action|refund|payment|invoice|coupon|variation|term|comment|job|task|transaction|charge|list|member|booking|ticket|entry|form|lead|contact|id)s?(?:_id)?)\s*(?:#|no\.?|number|[:=])?\s*$/i;

function numberToken(match, digits, unit, offset, text) {
  const before = text.slice(Math.max(0, offset - 30), offset);
  const after = text.slice(offset + match.length, offset + match.length + 40);
  if (!unit && /^\d{1,5}$/.test(digits)) {
    if (CODE_BEFORE.test(before)) return match;
    if (/^[1-5]\d\d$/.test(digits) && REASON_AFTER.test(after)) return match;
    if (/\[$/.test(before) && /^\]/.test(after) && digits.length >= 3) return match; // "[2002]" from a database driver
  }
  if (/HTTP\/$/i.test(before)) return match; // the protocol version in "HTTP/1.1"
  if (/\bargument\s*#$/i.test(before)) return match; // "Argument #2" in a PHP type error is a position
  if (/#\s*$/.test(before) || ID_BEFORE.test(before)) return "<id>";
  return `<n>${unit ?? ""}`;
}

/**
 * The part of a cleaned message that stays the same between repeats: dates and times, UUIDs, hashes, amounts,
 * quoted values that are not identifiers, ids and other numbers become placeholders. Error codes and HTTP status
 * codes stay.
 */
export function templateOf(message) {
  const out = String(message)
    .replace(DATE_TIME, "<time>")
    .replace(CLOCK, "<time>")
    .replace(UUID, "<uuid>")
    .replace(HASH, "<hash>")
    .replace(AMOUNT, "<amount>")
    .replace(QUOTED, (quoted, mark, body) => (IDENTIFIER.test(body) || /^<\w+>$/.test(body) ? quoted : `${mark}<str>${mark}`))
    .replace(NUMBER, numberToken)
    // A list of values ("IN (1, 2, 3)") becomes its first placeholder, whatever its length.
    .replace(/(<n>|<id>|'<str>'|"<str>")(?:\s*,\s*(?:<n>|<id>|'<str>'|"<str>"))+/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}
