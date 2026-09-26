// Groups the actions. Failed actions are grouped by hook and error template (cleanMessage, then templateOf), so
// failures that differ only in ids, amounts, dates or numbers share a group. Pending actions are the past-due ones
// (the export asks only for those, see the README) and are grouped by hook. Other statuses are counted and left out.
import { cleanMessage, failureOf, templateOf } from "./clean.mjs";
import { isEmptyArgs, maskArgs } from "./mask.mjs";

export const NO_MESSAGE = "(no failure message in the export)";
export const MAX_GROUPS = 20_000; // distinct failed groups kept; later new ones are only counted
const MAX_EXAMPLES = 3; // masked example arguments kept per group
const MAX_DISTINCT = 1000; // distinct argument lists tracked per group

function recurringLabel({ yes, no }) {
  if (yes && !no) return "yes";
  if (no && !yes) return "no";
  if (yes && no) return "some";
  return null;
}

function widen(group, time) {
  if (time === null || time === undefined) return;
  if (group.first === null || time < group.first) group.first = time;
  if (group.last === null || time > group.last) group.last = time;
}

function numbered(list, prefix) {
  const width = Math.max(2, String(list.length).length);
  list.forEach((group, i) => {
    group.id = `${prefix}${String(i + 1).padStart(width, "0")}`;
  });
  return list;
}

/**
 * Groups the actions read from the exports. Returns { failed, pastDue, stats }, both lists in order of first
 * appearance, with ids g01, g02 ... and p01, p02 ...
 */
export function groupActions(actions) {
  const failed = new Map();
  const pending = new Map();
  const stats = { failed: 0, pastDue: 0, other: {}, statusMissing: 0, noMessage: 0, overflow: 0, first: null, last: null };

  for (const action of actions) {
    if (action.status === null) stats.statusMissing++;
    const status = action.status ?? "failed";
    const recurring = action.recurring;

    if (status === "failed") {
      stats.failed++;
      const failure = failureOf(action.logs);
      const message = failure.text ? cleanMessage(failure.text) : "";
      if (!message) stats.noMessage++;
      const error = message ? templateOf(message) : NO_MESSAGE;
      const key = `${action.hook}\n${error}`;
      let group = failed.get(key);
      if (!group) {
        if (failed.size >= MAX_GROUPS) {
          stats.overflow++;
          continue;
        }
        group = {
          id: null,
          kind: "failed",
          hook: action.hook,
          error,
          failure: failure.kind,
          count: 0,
          ids: [],
          first: null,
          last: null,
          recurringCounts: { yes: 0, no: 0 },
          stopped: false,
          actionGroups: new Set(),
          argsSeen: new Set(),
          argsOverflow: false,
          argsMissing: false,
          examples: [],
          actions: [],
          order: action.order,
        };
        failed.set(key, group);
      }
      group.count++;
      if (action.id !== null) group.ids.push(action.id);
      const time = failure.time ?? action.scheduled;
      widen(group, time);
      widen(stats, time);
      if (recurring === true) group.recurringCounts.yes++;
      else if (recurring === false) group.recurringCounts.no++;
      group.stopped ||= failure.stopped;
      if (action.group) group.actionGroups.add(action.group);
      const argsKey = JSON.stringify(action.args);
      if (action.args === null) group.argsMissing = true;
      else if (!group.argsSeen.has(argsKey)) {
        if (group.argsSeen.size < MAX_DISTINCT) group.argsSeen.add(argsKey);
        else group.argsOverflow = true;
        if (group.examples.length < MAX_EXAMPLES && !isEmptyArgs(action.args)) {
          const masked = maskArgs(action.args);
          if (!group.examples.some((example) => JSON.stringify(example) === JSON.stringify(masked))) group.examples.push(masked);
        }
      }
      group.actions.push({ id: action.id, hook: action.hook, group: action.group, args: action.args, recurring });
    } else if (status === "pending" || status === "past-due") {
      stats.pastDue++;
      let group = pending.get(action.hook);
      if (!group) {
        group = {
          id: null,
          kind: "past-due",
          hook: action.hook,
          count: 0,
          ids: [],
          first: null,
          last: null,
          recurringCounts: { yes: 0, no: 0 },
          actionGroups: new Set(),
          order: action.order,
        };
        pending.set(action.hook, group);
      }
      group.count++;
      if (action.id !== null) group.ids.push(action.id);
      widen(group, action.scheduled);
      if (recurring === true) group.recurringCounts.yes++;
      else if (recurring === false) group.recurringCounts.no++;
      if (action.group) group.actionGroups.add(action.group);
    } else {
      stats.other[status] = (stats.other[status] ?? 0) + 1;
    }
  }

  const finish = (group) => {
    group.actionGroups = [...group.actionGroups].sort();
    group.recurring = recurringLabel(group.recurringCounts);
    return group;
  };
  const failedList = numbered([...failed.values()].map(finish), "g");
  for (const group of failedList) {
    // null (unknown) when an action in the group came without its arguments
    group.distinctArgs = group.argsMissing ? null : group.argsOverflow ? MAX_DISTINCT + 1 : group.argsSeen.size;
    delete group.argsSeen;
    delete group.argsOverflow;
    delete group.argsMissing;
  }
  return { failed: failedList, pastDue: numbered([...pending.values()].map(finish), "p"), stats };
}
