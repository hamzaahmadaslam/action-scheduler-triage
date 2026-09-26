// Two views of an action's arguments, neither of which holds personal data:
//   maskArgs()   for the report: values stay, except those under a personal-sounding name (email, phone, name,
//                address, note, token, key, ...), any email address, phone number, public IP address or URL query
//                found in a text value, and a text value that is a long token.
//   argsShape()  for Jev: the names and the types of the values ("number", "text"), never a value.
// The retry commands use the arguments exactly as exported (see commands.mjs); these views are never used for them.
import { EMAIL, cleanText, isPublicIp, visible } from "./clean.mjs";

const MAX_DEPTH = 4;
const MAX_ITEMS = 10; // array items kept
const MAX_KEYS = 20; // object keys kept
const MAX_TEXT = 80; // characters kept of a text value
const MAX_KEY = 60; // characters kept of a key

// Words that make a key's value personal or secret. Keys are split into words at "_", "-", "." and camelCase.
const PERSONAL_WORDS = new Set(
  (
    "email emails mail phone mobile tel telephone fax name names firstname lastname fullname username login " +
    "address addr street city postcode zip zipcode postal ip agent note notes message comment body content text " +
    "password passwd pass pwd secret token nonce key apikey auth authorization credential credentials card cvv cvc " +
    "iban ssn dob birth birthday signature cookie session recipient"
  ).split(" "),
);

const words = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Whether a key names personal or secret data, such as billing_email, customerPhone or api_key. */
export const isPersonalKey = (key) => words(key).some((word) => PERSONAL_WORDS.has(word));

// A phone number: nine digits or more with at least one space, bracket, dot, dash or a leading plus. Dates, which
// also mix digits and dashes, are left alone.
const PHONE_IN_TEXT = /(?<![\w.+])\+?\(?\d[\d\s().-]{6,}\d(?![\w.])/g;
const TOKEN = /^(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9_\-+/=.]{24,}$/;
const IP = /^[\da-fA-F:.]+$/;

function maskPhones(text) {
  return text.replace(PHONE_IN_TEXT, (match) => {
    const digits = match.replace(/\D/g, "").length;
    if (digits < 9 || !/[\s().+-]/.test(match) || /^\d{4}-\d{2}-\d{2}/.test(match)) return match;
    return "<phone>";
  });
}

function maskText(value) {
  const text = visible(value).trim();
  if (IP.test(text) && isPublicIp(text)) return "<ip>";
  if (TOKEN.test(text) && !text.includes("://")) return "<token>";
  const out = maskPhones(cleanText(text).replace(EMAIL, "<email>"));
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT - 3)}...` : out;
}

function cleanKey(key) {
  const out = visible(key).replace(EMAIL, "<email>").trim();
  return out.length > MAX_KEY ? `${out.slice(0, MAX_KEY - 3)}...` : out;
}

/** The arguments with personal values replaced by placeholders, for the report. */
export function maskArgs(value, key = "", depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return isPersonalKey(key) ? "<masked>" : value;
  if (typeof value === "string") return isPersonalKey(key) ? "<masked>" : maskText(value);
  if (depth >= MAX_DEPTH) return "...";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((item) => maskArgs(item, key, depth + 1));
    if (value.length > MAX_ITEMS) out.push(`... ${value.length - MAX_ITEMS} more`);
    return out;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const out = {};
    for (const [k, v] of entries.slice(0, MAX_KEYS)) out[cleanKey(k)] = maskArgs(v, k, depth + 1);
    if (entries.length > MAX_KEYS) out["..."] = `${entries.length - MAX_KEYS} more keys`;
    return out;
  }
  return "<value>";
}

/** The names and value types of the arguments, for Jev. */
export function argsShape(value, depth = 0) {
  if (value === null) return "null";
  if (typeof value === "boolean") return "true or false";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "text";
  if (depth >= MAX_DEPTH) return "...";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((item) => argsShape(item, depth + 1));
    if (value.length > MAX_ITEMS) out.push(`... ${value.length - MAX_ITEMS} more`);
    return out;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const out = {};
    for (const [k, v] of entries.slice(0, MAX_KEYS)) out[cleanKey(k)] = argsShape(v, depth + 1);
    if (entries.length > MAX_KEYS) out["..."] = `${entries.length - MAX_KEYS} more keys`;
    return out;
  }
  return "value";
}

/** True when there are no arguments: an empty list or object, or nothing at all. */
export function isEmptyArgs(args) {
  if (args === null || args === undefined) return true;
  if (Array.isArray(args)) return args.length === 0;
  if (typeof args === "object") return Object.keys(args).length === 0;
  return false;
}
