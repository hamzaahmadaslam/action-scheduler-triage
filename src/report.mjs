// Turns grouped and triaged results into the text report, the JSON report and the dry-run output. Every word in
// the output comes from the export or from the fixed templates here; Jev only returns probabilities.
import { readFileSync } from "node:fs";
import { visible } from "./clean.mjs";
import { commandsFor, pendingListCommand, runHookCommand } from "./commands.mjs";
import { JEV_ENDPOINT } from "./jev.mjs";
import { CAUSES, RETRY_CRITERIA, URGENCY, URGENCY_LABELS, questionsFor, stateFor } from "./questions.mjs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
// USD per million input tokens for jev-1.13 (TypeSafe's models page, 2026-09-26). Output tokens are free.
export const PRICE_PER_MILLION = 0.042;
/** Retry commands printed per group in the text report; the JSON report has all of them. */
export const COMMANDS_SHOWN = 10;
const IDS_SHOWN = 5;

/** What to look at before running a group again, by cause (shown for groups to fix first). */
export const HINTS = {
  "transient-network-or-timeout":
    "The failure looks temporary, but a rerun could repeat work that may already have happened. Check the other system (the payment gateway, the mail log, the receiving service) before running these again.",
  "rate-limited":
    "The remote service turned requests away. Wait for its limit to reset, or run fewer actions at a time (the action_scheduler_queue_runner_batch_size and action_scheduler_queue_runner_concurrent_batches filters), before running these again.",
  "credentials-or-auth": "Renew or re-enter the API key, token, password or license the plugin uses, then run the actions again.",
  "invalid-data":
    "Look at the records in the arguments (an order, product or customer that was deleted or changed) and fix or remove them; the same arguments will fail the same way.",
  "code-error":
    "Find the code that raised the error (the error or the PHP error log names the file and line), fix or update the plugin or theme, and test the callback before running the actions again.",
  "missing-plugin-or-callback":
    "No code handles this hook now. Reactivate the plugin that registered it, or cancel these actions if that plugin was removed on purpose.",
  other: "The error does not say why the actions failed. Check the PHP error log and the plugin's own logs around the failure times.",
};

const DECISION_WORDS = { retry: "retry", "fix-first": "fix first", review: "review" };
const RATE_LIMIT_NOTE = "These failed on a rate limit: wait until it resets, then queue them a few at a time.";
const PAST_DUE_NOTE =
  "Pending actions past their time usually mean the queue runner is not keeping up: WP-Cron not running, loopback requests failing, or a long backlog. `wp action-scheduler status` shows the runner and the size of the queue.";

const int = (n) => Math.round(n).toLocaleString("en-US");
const plural = (n, one, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
const clock = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(".000Z", "Z"));
const show = (text) => visible(text).replace(/\s+/g, " ").trim();

export function costOf(tokens) {
  return (tokens * PRICE_PER_MILLION) / 1e6;
}

export function formatCost(usd) {
  if (usd <= 0) return "$0";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1 - Math.floor(Math.log10(usd)))}`;
}

function topProbabilities(probabilities, name = (key) => key) {
  return Object.entries(probabilities ?? {})
    .filter(([, p]) => Number.isFinite(p) && p >= 0.005)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, p]) => `${name(key)} ${p.toFixed(2)}`)
    .join(", ");
}

function span(first, last, verb) {
  if (first === null) return `No ${verb === "Failed" ? "failure" : "scheduled"} times in the export`;
  if (first === last) return `${verb} ${clock(first)} UTC`;
  return `${verb} ${clock(first)} to ${clock(last)} UTC`;
}

function idList(ids) {
  if (!ids.length) return null;
  const shown = ids.slice(0, IDS_SHOWN).map(show).join(", ");
  return ids.length > IDS_SHOWN ? `${shown} and ${int(ids.length - IDS_SHOWN)} more` : shown;
}

function skippedText(other, invalid) {
  const entries = Object.entries(other);
  const count = entries.reduce((sum, [, n]) => sum + n, 0);
  const parts = [];
  if (count) parts.push(`${plural(count, "action")} with another status (${entries.map(([s, n]) => `${int(n)} ${show(s)}`).join(", ")})`);
  if (invalid) parts.push(`${plural(invalid, "entry", "entries")} without a hook`);
  return parts;
}

function headerLines(read, grouped, meta) {
  const { stats } = grouped;
  const lines = [`Input: ${meta.files.map(show).join(", ")}`];
  const parts = [`${int(stats.failed)} failed in ${plural(grouped.failed.length, "group")}`];
  if (stats.pastDue) parts.push(`${int(stats.pastDue)} past due in ${plural(grouped.pastDue.length, "group")}`);
  lines.push(`Actions: ${parts.join(", ")}`);
  const skipped = skippedText(stats.other, read.stats.invalid);
  if (skipped.length) lines.push(`Skipped: ${skipped.join("; ")}`);
  if (read.stats.duplicates) {
    const n = read.stats.duplicates;
    lines.push(`Note: ${plural(n, "repeated entry", "repeated entries")} (an action id already read) ${n === 1 ? "was" : "were"} left out.`);
  }
  if (stats.first !== null) {
    lines.push(stats.first === stats.last ? `Failed at ${clock(stats.first)} UTC` : `Failed between ${clock(stats.first)} and ${clock(stats.last)} UTC`);
  }
  if (stats.statusMissing) lines.push(`Note: ${plural(stats.statusMissing, "action")} had no status and ${stats.statusMissing === 1 ? "was" : "were"} read as failed.`);
  if (stats.noMessage) {
    lines.push(
      `Note: ${plural(stats.noMessage, "failed action")} had no failure message; if the export left out log_entries, export again with --fields=id,hook,status,group,recurring,scheduled_date,args,log_entries.`,
    );
  }
  if (stats.overflow) {
    const n = stats.overflow;
    lines.push(`Note: more than ${int(grouped.failed.length)} distinct failures; ${plural(n, "later action")} with new errors ${n === 1 ? "was" : "were"} counted but not grouped.`);
  }
  return lines;
}

function detailLine(group) {
  const parts = [span(group.first, group.last, "Failed")];
  if (group.recurring === "yes") parts.push("recurring");
  else if (group.recurring === "no") parts.push("single actions");
  else if (group.recurring === "some") parts.push("some recurring");
  if (group.count > 1) parts.push(group.distinctArgs <= 1 ? "the same arguments every time" : "different arguments");
  if (group.stopped) parts.push("Action Scheduler stopped scheduling it after repeated failures");
  return parts.join("; ");
}

function jevLine(group) {
  const parts = [];
  if (group.cause) parts.push(`cause ${topProbabilities(group.cause.probabilities)}`);
  if (group.retry !== null && group.retry !== undefined) parts.push(`safe to run again ${group.retry.toFixed(2)}`);
  if (group.urgency) {
    const levels = topProbabilities(group.urgency.probabilities, (level) => URGENCY_LABELS[Number(level)] ?? level);
    parts.push(`urgency ${group.urgency.score.toFixed(2)} of 3 (${levels})`);
  }
  return parts.length ? `Jev: ${parts.join("; ")}` : "Jev: no answers";
}

function groupBlock(group) {
  const pad = " ".repeat(group.id.length + 2);
  const urgency = group.urgency ? group.urgency.label : "no answer";
  const cause = group.cause ? group.cause.choice : "no answer";
  const lines = [`${group.id}  ${urgency}  ${cause}  ${int(group.count)} failed`];
  const where = group.actionGroups.length ? ` (group ${group.actionGroups.map(show).join(", ")})` : "";
  lines.push(`${pad}Hook: ${show(group.hook)}${where}`);
  lines.push(`${pad}Error: ${show(group.error)}`);
  lines.push(`${pad}${detailLine(group)}`);
  const ids = idList(group.ids);
  if (ids) lines.push(`${pad}Action IDs: ${ids}`);
  if (group.examples.length) lines.push(`${pad}Example arguments: ${group.examples.map((e) => JSON.stringify(e)).join("  ")}`);
  lines.push(`${pad}${jevLine(group)}`);

  if (group.decision === "retry") {
    const { commands, notCopied } = commandsFor(group);
    const recurring = group.actions.filter((a) => a.recurring === true).length;
    if (recurring) {
      const check = pendingListCommand(group.hook);
      const why = group.stopped
        ? "Action Scheduler stopped scheduling this recurring action; the plugin that owns it may schedule it again when it loads."
        : "Recurring: the next scheduled run repeats this work, so no commands are printed for it.";
      lines.push(`${pad}${why}${check ? ` Check for a pending run: ${check}` : ""}`);
    }
    if (commands.length) {
      if (group.cause.choice === "rate-limited") lines.push(`${pad}${RATE_LIMIT_NOTE}`);
      lines.push(`${pad}Commands to run by hand (printed only; this tool never runs them):`);
      for (const command of commands.slice(0, COMMANDS_SHOWN)) lines.push(`${pad}  ${command}`);
      if (commands.length > COMMANDS_SHOWN) lines.push(`${pad}  ${plural(commands.length - COMMANDS_SHOWN, "more command")} in the JSON report (--json).`);
    }
    for (const { id, reason } of notCopied.slice(0, IDS_SHOWN)) lines.push(`${pad}Not copied: action ${show(id ?? "without an id")}: ${reason}.`);
    if (notCopied.length > IDS_SHOWN) lines.push(`${pad}Not copied: ${plural(notCopied.length - IDS_SHOWN, "more action")}.`);
  } else if (group.decision === "fix-first") {
    lines.push(`${pad}What to check: ${HINTS[group.cause.choice]}`);
    const check = group.stopped ? pendingListCommand(group.hook) : null;
    if (check) lines.push(`${pad}After the fix, check that it is scheduled again: ${check}`);
  } else {
    lines.push(`${pad}Review: ${group.reviewReasons.join("; ")}.`);
  }
  return lines.join("\n");
}

function pastDueBlock(group) {
  const pad = " ".repeat(group.id.length + 2);
  const lines = [`${group.id}  ${show(group.hook)}  ${int(group.count)} pending`];
  const parts = [];
  if (group.actionGroups.length) parts.push(`Group ${group.actionGroups.map(show).join(", ")}`);
  parts.push(span(group.first, group.last, "scheduled").replace(/^No scheduled times/, "no scheduled times"));
  if (group.recurring === "yes") parts.push("recurring");
  lines.push(`${pad}${parts.join("; ")}`);
  const ids = idList(group.ids);
  if (ids) lines.push(`${pad}Action IDs: ${ids}`);
  const command = runHookCommand(group.hook);
  if (command) lines.push(`${pad}To run them now by hand (printed only): ${command}`);
  return lines.join("\n");
}

function overviewLines(ranked) {
  const rows = ranked.map((g) => [
    g.id,
    g.urgency ? g.urgency.label : "no answer",
    DECISION_WORDS[g.decision] ?? "review",
    g.cause ? g.cause.choice : "no answer",
    int(g.count),
    show(g.hook),
  ]);
  const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) => row.map((cell, i) => (i === 4 ? cell.padStart(widths[i]) : i < 5 ? cell.padEnd(widths[i]) : cell)).join("  "));
}

function counts(ranked) {
  const of = (decision) => ranked.filter((g) => g.decision === decision).length;
  return { retry: of("retry"), fixFirst: of("fix-first"), review: ranked.length - of("retry") - of("fix-first") };
}

/** The human-readable report: an overview most urgent first, then each list with its details. */
export function reportText(read, grouped, outcome, ranked, meta) {
  const lines = [`action-scheduler-triage ${VERSION}`, ...headerLines(read, grouped, meta)];
  if (!ranked.length && !grouped.pastDue.length) {
    lines.push("", "No failed or pending actions in the input.");
    return `${lines.join("\n")}\n`;
  }
  if (ranked.length) {
    const tokens = outcome.usage.input_tokens;
    const n = counts(ranked);
    lines.push(`Jev: model ${outcome.model ?? meta.model}, ${plural(outcome.requests, "request")}, ${int(tokens)} input tokens (about ${formatCost(costOf(tokens))})`);
    lines.push(`Threshold ${meta.threshold.toFixed(2)}: ${int(n.retry)} safe to retry, ${int(n.fixFirst)} fix first, ${int(n.review)} for review`);
    lines.push("", "Failed groups, most urgent first", ...overviewLines(ranked));
    const sections = [
      ["Safe to retry, most urgent first", ranked.filter((g) => g.decision === "retry")],
      ["Fix first, most urgent first", ranked.filter((g) => g.decision === "fix-first")],
      ["For review, most urgent first (an unsure or missing answer, or answers that disagree)", ranked.filter((g) => g.decision === "review")],
    ];
    for (const [title, groups] of sections) {
      if (!groups.length) continue;
      lines.push("", title);
      for (const group of groups) lines.push("", groupBlock(group));
    }
  } else {
    lines.push("", "No failed actions in the input.");
  }
  if (grouped.pastDue.length) {
    lines.push("", "Past due: pending actions whose time has passed (not sent to Jev)");
    for (const group of grouped.pastDue) lines.push("", pastDueBlock(group));
    lines.push("", PAST_DUE_NOTE);
  }
  return `${lines.join("\n")}\n`;
}

function groupJson(group) {
  const out = {
    id: group.id,
    decision: group.decision ?? null,
    review_reasons: group.reviewReasons ?? [],
    urgency: group.urgency ?? null,
    cause: group.cause ?? null,
    safe_to_run_again: group.retry ?? null,
    hook: group.hook,
    action_groups: group.actionGroups,
    error: group.error,
    failure_kind: group.failure,
    count: group.count,
    recurring: group.recurring,
    recurring_schedule_stopped: group.stopped,
    distinct_arguments: group.distinctArgs,
    first_failed: iso(group.first),
    last_failed: iso(group.last),
    action_ids: group.ids,
    example_arguments: group.examples,
  };
  if (group.decision === "retry") {
    const { commands, notCopied } = commandsFor(group);
    out.retry_commands = commands;
    out.not_copied = notCopied;
    if (group.cause.choice === "rate-limited") out.note = RATE_LIMIT_NOTE;
    if (group.actions.some((a) => a.recurring === true)) out.pending_check = pendingListCommand(group.hook);
  }
  if (group.decision === "fix-first") {
    out.what_to_check = HINTS[group.cause.choice];
    if (group.stopped) out.pending_check = pendingListCommand(group.hook);
  }
  return out;
}

function pastDueJson(group) {
  return {
    id: group.id,
    hook: group.hook,
    action_groups: group.actionGroups,
    count: group.count,
    recurring: group.recurring,
    first_scheduled: iso(group.first),
    last_scheduled: iso(group.last),
    action_ids: group.ids,
    run_command: runHookCommand(group.hook),
  };
}

function summaryJson(read, grouped, meta) {
  const { stats } = grouped;
  return {
    tool: "action-scheduler-triage",
    version: VERSION,
    files: meta.files,
    actions_read: read.stats.entries,
    failed: stats.failed,
    past_due: stats.pastDue,
    skipped_statuses: stats.other,
    entries_without_hook: read.stats.invalid,
    duplicates: read.stats.duplicates,
    status_missing: stats.statusMissing,
    failed_without_message: stats.noMessage,
    ungrouped_failures: stats.overflow,
    first_failed: iso(stats.first),
    last_failed: iso(stats.last),
  };
}

/** The JSON report: the same groups and order as the text report, with every probability and every command. */
export function reportJson(read, grouped, outcome, ranked, meta) {
  const n = counts(ranked);
  const report = {
    ...summaryJson(read, grouped, meta),
    model: ranked.length ? (outcome.model ?? meta.model) : null,
    requests: outcome.requests,
    usage: outcome.usage,
    threshold: meta.threshold,
    groups_total: ranked.length,
    retry: n.retry,
    fix_first: n.fixFirst,
    review: n.review,
    groups: ranked.map(groupJson),
    past_due_groups: grouped.pastDue.map(pastDueJson),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

const byCount = (groups) => [...groups].sort((a, b) => b.count - a.count || a.order - b.order);

/** What a run would send, without sending it: the requests, the three questions, and each group's state. */
export function dryRunText(read, grouped, requests, meta) {
  const lines = [`action-scheduler-triage ${VERSION} (dry run: nothing was sent)`, ...headerLines(read, grouped, meta)];
  if (!requests.length) {
    lines.push("", "Nothing to send: no failed actions in the input.");
    return `${lines.join("\n")}\n`;
  }
  const total = requests.reduce((sum, r) => sum + r.estimatedTokens, 0);
  lines.push("", `Would send ${plural(requests.length, "request")} to ${JEV_ENDPOINT} with model ${meta.model}:`);
  requests.forEach((request, i) => {
    lines.push(`  request ${i + 1}: ${plural(request.ids.length, "group")}, about ${int(request.estimatedTokens)} input tokens`);
  });
  lines.push(`Estimated total: about ${int(total)} input tokens, about ${formatCost(costOf(total))} at $${PRICE_PER_MILLION} per million input tokens`);

  const example = grouped.failed[0].id;
  lines.push("", `Questions for each group (shown for ${example}; every group gets the same three under its own key):`);
  for (const [key, question] of Object.entries(questionsFor(example))) {
    lines.push("", `${key} (${question.type}): ${question.instructions}`);
    if (question.type === "choice") for (const option of Object.keys(CAUSES)) lines.push(`  ${option}: ${CAUSES[option]}`);
    else if (question.type === "noul") lines.push(`  yes: ${RETRY_CRITERIA.true}`, `  no: ${RETRY_CRITERIA.false}`);
    else URGENCY.forEach((level, i) => lines.push(`  ${i} ${level}`));
  }

  lines.push("", "Groups, most frequent first, with the state sent for each (--dry-run --json prints the exact request bodies):");
  for (const group of byCount(grouped.failed)) {
    const state = stateFor(group, grouped.stats.last);
    const pad = " ".repeat(group.id.length + 2);
    lines.push("", `${group.id}  ${int(group.count)} failed  ${show(state.hook)}`);
    for (const [key, value] of Object.entries(state)) {
      if (key === "hook") continue;
      lines.push(`${pad}${key}: ${typeof value === "string" ? show(value) : JSON.stringify(value)}`);
    }
  }
  const pastDue = grouped.pastDue.length;
  if (pastDue) lines.push("", `${plural(pastDue, "past-due group")} ${pastDue === 1 ? "is" : "are"} listed in the report and never sent.`);
  return `${lines.join("\n")}\n`;
}

/** The dry run as JSON, including the exact body of every request that would be sent. */
export function dryRunJson(read, grouped, requests, meta) {
  const total = requests.reduce((sum, r) => sum + r.estimatedTokens, 0);
  const report = {
    ...summaryJson(read, grouped, meta),
    dry_run: true,
    endpoint: JEV_ENDPOINT,
    model: meta.model,
    groups_total: grouped.failed.length,
    estimated_input_tokens: total,
    estimated_cost_usd: Number(costOf(total).toPrecision(3)),
    requests: requests.map((request) => ({
      groups: request.ids,
      estimated_input_tokens: request.estimatedTokens,
      body: { model: meta.model, state: request.state, questions: request.questions },
    })),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
