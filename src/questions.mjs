// The three questions asked about every failed group, the state each group contributes, and how groups are packed
// into requests. Jev reads the state once per request and answers every question against it, so a request carries
// as many groups as fit the token budget, each under its own key ("groups.g07"), with three questions per group.
// Error text and arguments go only into the state; the questions name a group by its key and hold fixed text.
import { choice, noul, score } from "./jev.mjs";
import { argsShape, isEmptyArgs } from "./mask.mjs";

export const CAUSES = {
  "transient-network-or-timeout":
    "A temporary problem outside the action's own code and data: a connection that timed out or was refused, a DNS or SSL error, a remote service that was briefly down (HTTP 500, 502, 503 or 504), a lost database connection or a deadlock, or the action running out of time while it waited.",
  "rate-limited":
    "A remote service turned requests away because too many were sent: HTTP 429, too many requests, rate limit, quota exceeded or throttled.",
  "credentials-or-auth":
    "A remote service or WordPress refused the request because of an API key, token, password, license or permission: HTTP 401 or 403, unauthorized, forbidden, an invalid or expired key or token, or a failed login.",
  "invalid-data":
    "The action's own data is wrong or gone: a deleted or missing order, product, customer or post, a missing or malformed value, a duplicate record, or a remote service rejecting the data as invalid (HTTP 400 or 422).",
  "code-error":
    "A bug in PHP code: an uncaught error or exception, a call to an undefined function or method, a type error, a syntax error, or running out of PHP memory.",
  "missing-plugin-or-callback":
    "Nothing handled the hook: no callbacks are registered for it, or the plugin, class or function that should run it is deactivated, deleted or not loaded.",
  other: "None of the above, or the error does not say why the actions failed.",
};

/** Causes that pass once time goes by; a group needs one of these to be listed as safe to retry. */
export const TRANSIENT = new Set(["transient-network-or-timeout", "rate-limited"]);

export const RETRY_CRITERIA = {
  true: "The failure came from a temporary condition that has likely passed, such as a timeout, a dropped connection, a rate limit or a service that was briefly down, and running the same actions again would not repeat anything that may already have happened, such as a payment, a refund, a sent email or a created order.",
  false: "Running them again unchanged would fail the same way until code, data, credentials or a missing plugin is fixed, or it could repeat a payment, a refund, an email or an order that may already have happened.",
};

export const URGENCY = [
  "Can wait: housekeeping or reporting work, such as a cleanup, a cache refresh or an analytics import, with no effect on customers, orders or money.",
  "Routine: a background task is behind or failing with a small or delayed effect, such as a data sync, a product feed, a report or a newsletter.",
  "Soon: customers or staff will notice within a day, such as missing order or shipping emails, stock or prices out of sync, orders not reaching another system, or a recurring job that has stopped.",
  "Now: money, orders or access are affected, such as payments or subscription renewals not taken, orders not created or completed, refunds failing, or customers losing access.",
];
export const URGENCY_LABELS = ["can wait", "routine", "soon", "now"];

export const ABOUT =
  "Groups of failed background actions from Action Scheduler, the job queue that WooCommerce and many WordPress plugins use, exported from one site. Each group is one hook that failed with the same error one or more times. In `error`, ids, amounts, dates, numbers and email addresses were replaced with placeholders such as <id>, <amount> and <n>. `argument_types` gives the names and value types of an action's arguments, without the values.";

const ERROR_CHARS = 500; // characters of a group's error that are sent
const HOOK_CHARS = 191; // Action Scheduler's own limit for hook names
const DAY_MS = 24 * 60 * 60 * 1000;

// The model's limits (TypeSafe's models page, 2026-09-26): 32k tokens for the state plus the longest question,
// 64k for the state plus all questions. Token counts here are estimates, so requests are packed to 90% of each.
export const BUDGET = { state: 28_800, request: 57_600 };

/** A rough token count: one token per three characters of JSON, which overestimates English text. */
export function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / 3);
}

export function questionsFor(id) {
  return {
    [`${id}_cause`]: choice(`What most likely caused the failures in \`groups.${id}\`?`, CAUSES),
    [`${id}_retry`]: noul(
      `Is it safe to run the actions in \`groups.${id}\` again as they are, with the same arguments and without changing any code, data or settings first?`,
      RETRY_CRITERIA,
    ),
    [`${id}_urgency`]: score(`How soon should someone deal with the failures in \`groups.${id}\`?`, URGENCY),
  };
}

/** How often a group failed, as words: Jev reads words more reliably than counts. */
export function occurrences(count) {
  if (count <= 1) return "once";
  if (count < 10) return "a few times";
  if (count < 100) return "dozens of times";
  if (count < 1000) return "hundreds of times";
  return "thousands of times or more";
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** The first non-empty arguments in a group, whose names and types are sent. */
function firstArgs(group) {
  return group.actions.find((action) => !isEmptyArgs(action.args))?.args;
}

/** What is sent about one failed group. `exportEnd` is the time of the newest failure in the export. */
export function stateFor(group, exportEnd) {
  const state = { hook: clip(group.hook, HOOK_CHARS) };
  if (group.actionGroups.length) state.action_group = clip(group.actionGroups.join(", "), 200);
  state.error = clip(group.error, ERROR_CHARS);
  if (group.recurring) state.recurring = group.recurring;
  state.occurrences = occurrences(group.count);
  if (group.count > 1) state.arguments = group.distinctArgs <= 1 ? "the same for every action" : "different between actions";
  const args = firstArgs(group);
  if (args !== undefined) state.argument_types = argsShape(args);
  if (exportEnd != null && group.last != null) state.failed_in_last_24_hours_of_export = group.last >= exportEnd - DAY_MS ? "yes" : "no";
  if (group.stopped) state.recurring_schedule_stopped = "yes: Action Scheduler stopped scheduling this recurring action after repeated failures";
  return state;
}

/**
 * Packs groups into requests, in order, so that each stays under the budget: the state plus the longest question
 * under `budget.state`, and the state plus all questions under `budget.request`. `maxGroups` caps the groups per
 * request when a smaller state is wanted. A group too big for the budget still goes, alone.
 */
export function planRequests(groups, exportEnd, { budget = BUDGET, maxGroups = Infinity } = {}) {
  const requests = [];
  const empty = () => ({ ids: [], state: { about: ABOUT, groups: {} }, questions: {}, stateTokens: estimateTokens({ about: ABOUT, groups: {} }), questionTokens: 0 });
  let current = null;
  for (const group of groups) {
    const entry = stateFor(group, exportEnd);
    const questions = questionsFor(group.id);
    const stateTokens = estimateTokens({ [group.id]: entry });
    const questionTokens = estimateTokens(questions);
    const longest = Math.max(...Object.values(questions).map(estimateTokens));
    if (
      current &&
      (current.ids.length >= maxGroups ||
        current.stateTokens + stateTokens + longest > budget.state ||
        current.stateTokens + stateTokens + current.questionTokens + questionTokens > budget.request)
    ) {
      requests.push(current);
      current = null;
    }
    current ??= empty();
    current.ids.push(group.id);
    current.state.groups[group.id] = entry;
    Object.assign(current.questions, questions);
    current.stateTokens += stateTokens;
    current.questionTokens += questionTokens;
  }
  if (current) requests.push(current);
  return requests.map(({ ids, state, questions }) => ({
    ids,
    state,
    questions,
    estimatedTokens: estimateTokens(state) + estimateTokens(questions),
  }));
}
