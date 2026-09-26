// Sends the planned requests to Jev one after another, reads each answer back onto its group, and sorts every
// group into one of three lists:
//   retry      the cause is temporary (a timeout, a dropped connection, a rate limit) and Jev says running the
//              actions again unchanged is safe, both at or above the threshold
//   fix-first  Jev says running them again unchanged is not safe (at or below 1 minus the threshold), and the
//              cause is clear
//   review     anything else: an answer below the threshold or missing, or a "safe" answer for a cause that a
//              rerun cannot fix (the answers disagree)
// Nothing is dropped, and nothing is run: the tool only prints what it found.
import { askJev } from "./jev.mjs";
import { CAUSES, TRANSIENT, URGENCY_LABELS } from "./questions.mjs";

export const DEFAULT_THRESHOLD = 0.8;

// Rounding keeps float noise (1 - 0.8 is 0.19999999999999996) from moving an answer that sits on the threshold.
const round = (value) => Math.round(value * 1e6) / 1e6;
const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function readCause(answer) {
  if (!answer || answer.type !== "choice" || !Object.hasOwn(CAUSES, answer.choice)) return null;
  if (!isProbability(answer.confidence) || !answer.probabilities || typeof answer.probabilities !== "object") return null;
  return { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities };
}

export function readRetry(answer) {
  if (!answer || answer.type !== "noul" || !isProbability(answer.noul)) return null;
  return answer.noul;
}

export function readUrgency(answer) {
  if (!answer || answer.type !== "score" || !Number.isFinite(answer.score) || !isProbability(answer.confidence)) return null;
  // The score is a probability-weighted position from 0 to 3; rounding it gives the level it is closest to.
  const level = Math.min(URGENCY_LABELS.length - 1, Math.max(0, Math.round(answer.score)));
  return {
    label: URGENCY_LABELS[level],
    level,
    score: answer.score,
    confidence: answer.confidence,
    probabilities: answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {},
  };
}

/** Sets group.decision (retry, fix-first or review) and group.reviewReasons from the answers on the group. */
export function decide(group, threshold) {
  const reasons = [];
  const { cause, retry } = group;
  const yes = retry !== null && round(retry) >= threshold;
  const no = retry !== null && round(1 - retry) >= threshold;
  const two = (n) => n.toFixed(2);
  if (!cause) reasons.push("no cause answer from Jev");
  else if (round(cause.confidence) < threshold) reasons.push(`cause confidence ${two(cause.confidence)}, below ${two(threshold)}`);
  if (retry === null) reasons.push("no safe-to-run-again answer from Jev");
  else if (!yes && !no) reasons.push(`safe to run again ${two(retry)}, between ${two(round(1 - threshold))} and ${two(threshold)}`);
  if (!group.urgency) reasons.push("no urgency answer from Jev");
  if (!reasons.length && yes && !TRANSIENT.has(cause.choice)) {
    reasons.push(`Jev says safe to run again (${retry.toFixed(2)}) but the cause is ${cause.choice}`);
  }
  group.decision = reasons.length ? "review" : yes ? "retry" : "fix-first";
  group.reviewReasons = reasons;
  return group;
}

/** Copies the answers for one group out of a response's `answers` map and decides. */
export function applyAnswers(group, answers, threshold) {
  group.cause = readCause(answers?.[`${group.id}_cause`]);
  group.retry = readRetry(answers?.[`${group.id}_retry`]);
  group.urgency = readUrgency(answers?.[`${group.id}_urgency`]);
  return decide(group, threshold);
}

/** Asks Jev every planned request. Options other than `threshold` go to askJev (key, model, fetch, retries). */
export async function triage(groups, requests, { threshold, ...jevOptions }) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const usage = { input_tokens: 0, output_tokens: 0 };
  let model = null;
  for (const request of requests) {
    const response = await askJev(request.state, request.questions, jevOptions);
    model = typeof response.model === "string" ? response.model : model;
    usage.input_tokens += Number(response.usage?.input_tokens) || 0;
    usage.output_tokens += Number(response.usage?.output_tokens) || 0;
    for (const id of request.ids) applyAnswers(byId.get(id), response.answers, threshold);
  }
  return { model, usage, requests: requests.length };
}

/** Most urgent first; ties go to the group that failed more often, then to the one that came first. */
export function rank(groups) {
  return [...groups].sort((a, b) => (b.urgency?.score ?? -1) - (a.urgency?.score ?? -1) || b.count - a.count || a.order - b.order);
}
