# action-scheduler-triage

A command-line tool for WooCommerce and WordPress sites that use Action Scheduler: it reads the failed actions you
export with WP-CLI, groups them by hook and error, and sorts the groups into those that are safe to run again
unchanged, those that need a fix first, and those a person should look at.

Action Scheduler keeps every failed background action with its log, and a busy store can collect hundreds: a CRM sync
that hit a rate limit, receipts that stopped after an SMTP password change, a payment capture that timed out. The
admin screen shows them one row at a time. Grouping repeats and reading Action Scheduler's log format is exact work,
so the tool does it in code. Deciding what caused a group, and whether running it again could repeat a payment or an
email, takes judgment. Jev answers those questions with probabilities, and a group it is unsure about goes to a
review list instead of getting a retry command.

The tool is read-only. It reads JSON files and prints a report. It never runs WP-CLI, never connects to your
database and never retries anything itself: the WP-CLI commands in the report are for you to read and run by hand.

## How it uses Jev

Failed actions are grouped in code by hook and error. The error is the failure message in the action's log; Action
Scheduler's own lines such as "action created" and "action started via WP Cron" are skipped. Ids, amounts, dates,
times, numbers, hashes and email addresses in the error become placeholders, so "order #1043 of $49.00" and
"order #1051 of $129.50" share a group, while error codes and HTTP status codes (cURL error 28, HTTP 429) stay
because they tell causes apart. Both wordings Action Scheduler has used for an action that ran past its time limit
read as one error.

Then Jev gets three questions per group:

- a choice of cause: `transient-network-or-timeout`, `rate-limited`, `credentials-or-auth`, `invalid-data`,
  `code-error`, `missing-plugin-or-callback` or `other`, each with a one-line description;
- a yes/no (a noul): is it safe to run these actions again as they are, with the same arguments and without changing
  code, data or settings first? Safe means the failure came from a temporary condition that has likely passed and a
  rerun would not repeat a payment, a refund, an email or an order that may already have happened;
- a score of urgency on four levels: can wait, routine, soon, now.

Code then puts each group in one list, with a threshold of 0.8 unless you set `--threshold`:

- safe to retry: the cause is `transient-network-or-timeout` or `rate-limited` with confidence at or above the
  threshold, and the yes/no answer is at or above it;
- fix first: the yes/no answer is at or below 1 minus the threshold (0.2), and the cause's confidence is at or
  above the threshold;
- review: everything else, including a "safe" answer for a cause that a rerun cannot fix, where the two answers
  disagree, and a yes/no answer of exactly 0.5 at a threshold of 0.5, which would meet both conditions above.

The groups go into as few requests as TypeSafe's limits allow (32k tokens for the state plus the longest question,
64k for the whole request). Each group sits under its own key in the state, such as `groups.g07`, and its questions
name that key: error text and arguments are only in the state, and the questions are fixed text. The 12 groups of the
example fit in one request. Every result is printed with its probabilities. Jev is TypeSafe AI's System One model: it
answers typed questions with probabilities and writes no text, so every word in the report comes from your export or
from fixed text in this tool.

## Install

```sh
npm install -g github:hamzaahmadaslam/action-scheduler-triage
```

It needs Node 20 or later and installs no other packages.

## Usage

### 1. Export the failed actions

On the server, with WP-CLI and Action Scheduler 3.9.1 or later (the release that added the
`wp action-scheduler action` commands; `wp action-scheduler version` prints the version your site loads):

```sh
wp action-scheduler action list --status=failed --orderby=modified --order=DESC --per_page=1000 \
  --fields=id,hook,status,group,recurring,scheduled_date,args,log_entries --format=json > failed-actions.json
```

- `--fields` must name `args` and `log_entries`. The default fields leave both out. Without the log there is no error
  to group by, and without the arguments no retry command can be written.
- Set `--per_page`: without it Action Scheduler returns 5 actions. `--orderby=modified --order=DESC` puts the most
  recent failures first; `--per_page=-1` exports all of them.
- On multisite, add `--url=<site>` as for any `wp` command.

The past-due actions (pending actions whose time has passed) can go in a second file:

```sh
wp action-scheduler action list --status=pending --date=now --per_page=1000 \
  --fields=id,hook,status,group,recurring,scheduled_date,args,log_entries --format=json > past-due-actions.json
```

Sources: the list command's options and fields are in Action Scheduler's
[`Action_Command.php`](https://github.com/woocommerce/action-scheduler/blob/trunk/classes/WP_CLI/Action_Command.php)
and [`List_Command.php`](https://github.com/woocommerce/action-scheduler/blob/trunk/classes/WP_CLI/Action/List_Command.php);
the default of 5 results is in `get_query_actions_sql()` in
[`ActionScheduler_DBStore.php`](https://github.com/woocommerce/action-scheduler/blob/trunk/classes/data-stores/ActionScheduler_DBStore.php);
[actionscheduler.org/wp-cli](https://actionscheduler.org/wp-cli/) lists the commands.

### 2. Run the triage

```sh
export TYPESAFE_API_KEY="..."
action-scheduler-triage failed-actions.json
action-scheduler-triage failed-actions.json past-due-actions.json
action-scheduler-triage failed-actions.json --json > triage.json
action-scheduler-triage failed-actions.json --dry-run
ssh example-host 'cd /srv/site && wp action-scheduler action list --status=failed --per_page=1000 --fields=id,hook,status,group,recurring,scheduled_date,args,log_entries --format=json' | action-scheduler-triage -
```

| Option            | What it does                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--json`          | Print JSON instead of the text report                                               |
| `--threshold <p>` | Confidence from 0.5 to 1 below which a group goes to review (default 0.8)           |
| `--batch <n>`     | Send at most n groups per request (default: as many as fit the token budget)        |
| `--dry-run`       | Group the actions, then print the questions and a token estimate; nothing is sent   |
| `-h`, `--help`    | Show the help                                                                       |
| `-v`, `--version` | Show the version                                                                    |

`TYPESAFE_API_KEY` holds your key and is not needed for `--dry-run`. `TYPESAFE_MODEL` picks the model
(`jev-latest` by default). Give one or more exports; `-` reads one from standard input. Lines that WP-CLI or PHP print
before the JSON, such as notices, are skipped, and an action id that appears twice is counted once. The exit code is
0 when the report is printed, 1 for a TypeSafe error (refused key, invalid request, rate limit, overload, timeout, an
answer that cannot be read) or a report that cannot be written, and 2 for a missing key, bad options or an export
that cannot be read.

### The retry commands

Action Scheduler does not run a failed action again: its runner skips any action that is not pending
(`process_action()` in
[`ActionScheduler_Abstract_QueueRunner.php`](https://github.com/woocommerce/action-scheduler/blob/trunk/classes/abstracts/ActionScheduler_Abstract_QueueRunner.php)),
so `wp action-scheduler action run <id>` does nothing for a failed one. Running the work again means a new action
with the same hook, arguments and group
([`Create_Command.php`](https://github.com/woocommerce/action-scheduler/blob/trunk/classes/WP_CLI/Action/Create_Command.php)),
which is what the report prints for each action in a group judged safe to retry:

```sh
wp action-scheduler action create example_crm_sync_customer async --args='{"customer_id":265}' --group=example-crm
```

- The arguments are copied exactly as exported, because a masked value would run the action with the wrong data.
  Treat the report like the export: it can hold customer data.
- Commands are quoted for a POSIX shell (bash, zsh, sh), as used over SSH. Characters that a terminal could act on
  are written as JSON `\u` escapes.
- The new action gets Action Scheduler's default priority, 10.
- Recurring actions get no commands: their next scheduled run repeats the work. The report prints a read-only
  command that lists the pending run instead.
- An action is left out, with the reason, when the export left its arguments out, when its arguments cannot be
  copied exactly (a number too large for JavaScript, or numbered keys whose order reading the JSON can change), or
  when its hook or group name holds control characters or the hook starts with a dash, which WP-CLI would read as an
  option.
- The text report shows up to 10 commands per group and the JSON report has all of them. To collect every command
  in a file you can read before running it:
  `jq -r '.groups[] | select(.decision == "retry") | .retry_commands[]' triage.json > retry.sh`

### Past-due actions

Pending actions in the input are listed per hook, with `wp action-scheduler run --hooks=<hook>` to process them by
hand. They are not sent to Jev: they have not failed, and the usual reason they wait (WP-Cron not running, loopback
requests failing, a long backlog) is a queue problem that `wp action-scheduler status` shows. Every pending action in
the input counts as past due, which is what the export above selects.

## Example

The example exports are synthetic: [`examples/failed-actions.json`](examples/failed-actions.json) holds 88 actions
(87 failed, 1 canceled) and [`examples/past-due-actions.json`](examples/past-due-actions.json) holds 9 pending ones.
Every hook, host, id, email address and value in them is invented. The output below came from `npm run example`,
which runs the tool with hand-written fixture answers ([`examples/answers.json`](examples/answers.json)) in place of
Jev, so the probabilities are illustrations and the model shows as `fixture`. A live run gives its own numbers.

```sh
action-scheduler-triage examples/failed-actions.json examples/past-due-actions.json
```

```text
action-scheduler-triage 1.0.0
Input: examples/failed-actions.json, examples/past-due-actions.json
Actions: 87 failed in 12 groups, 9 past due in 2 groups
Skipped: 1 action with another status (1 canceled)
Failed between 2026-09-18 03:10 and 2026-09-25 18:30 UTC
Jev: model fixture, 1 request, 13,592 input tokens
Threshold 0.80: 3 safe to retry, 7 fix first, 2 for review

Failed groups, most urgent first
g02  now       fix first  transient-network-or-timeout   6  example_gateway_capture_payment
g01  soon      fix first  credentials-or-auth            8  example_mailer_send_receipt
g05  soon      review     transient-network-or-timeout  14  example_webhooks_deliver
g08  routine   fix first  code-error                     5  example_reports_rebuild
g04  routine   fix first  code-error                     3  example_invoices_generate_pdf
g07  routine   retry      transient-network-or-timeout   4  example_rates_refresh
g03  routine   review     transient-network-or-timeout   4  example_loyalty_award_points
g11  routine   fix first  invalid-data                   5  example_stock_import_update
g06  routine   retry      rate-limited                  22  example_crm_sync_customer
g10  routine   retry      transient-network-or-timeout   9  example_feed_push_product
g09  can wait  fix first  invalid-data                   4  example_newsletter_subscribe
g12  can wait  fix first  missing-plugin-or-callback     3  example_legacy_cleanup

Safe to retry, most urgent first

[...]

g06  routine  rate-limited  22 failed
     Hook: example_crm_sync_customer (group example-crm)
     Error: HTTP 429 Too Many Requests: rate limit exceeded, retry after <n> seconds
     Failed 2026-09-24 08:10 to 2026-09-24 08:45 UTC; single actions; different arguments
     Action IDs: 4136, 4135, 4134, 4133, 4132 and 17 more
     Example arguments: {"customer_id":265}  {"customer_id":258}  {"customer_id":251}
     Jev: cause rate-limited 0.96, transient-network-or-timeout 0.03, other 0.01; safe to run again 0.91; urgency 1.12 of 3 (routine 0.84, soon 0.14, can wait 0.02)
     These failed on a rate limit: wait until it resets, then queue them a few at a time.
     Commands to run by hand (printed only; this tool never runs them):
       wp action-scheduler action create example_crm_sync_customer async --args='{"customer_id":265}' --group=example-crm
       wp action-scheduler action create example_crm_sync_customer async --args='{"customer_id":258}' --group=example-crm
       [...]
       12 more commands in the JSON report (--json).

[...]

Fix first, most urgent first

g02  now  transient-network-or-timeout  6 failed
     Hook: example_gateway_capture_payment (group example-gateway)
     Error: Gateway request timed out after <n> seconds while capturing payment for order #<id> of <amount>
     Failed 2026-09-25 14:02 to 2026-09-25 15:47 UTC; single actions; different arguments
     Action IDs: 4155, 4154, 4153, 4152, 4151 and 1 more
     Example arguments: {"order_id":1077,"amount":"12.00","currency":"USD"}  {"order_id":1070,"amount":"75.25","currency":"USD"}  {"order_id":1062,"amount":"240.00","currency":"USD"}
     Jev: cause transient-network-or-timeout 0.91, other 0.05, rate-limited 0.02; safe to run again 0.08; urgency 2.94 of 3 (now 0.94, soon 0.06)
     What to check: The failure looks temporary, but a rerun could repeat work that may already have happened. Check the other system (the payment gateway, the mail log, the receiving service) before running these again.

[...]

For review, most urgent first (an unsure or missing answer, or answers that disagree)

g05  soon  transient-network-or-timeout  14 failed
     Hook: example_webhooks_deliver (group example-webhooks)
     Error: cURL error 28: Operation timed out after <n> milliseconds with <n> bytes received
     Failed 2026-09-24 09:12 to 2026-09-24 09:58 UTC; single actions; different arguments
     Action IDs: 4114, 4113, 4112, 4111, 4110 and 9 more
     Example arguments: {"webhook_id":3,"order_id":1053}  {"webhook_id":3,"order_id":1052}  {"webhook_id":3,"order_id":1051}
     Jev: cause transient-network-or-timeout 0.93, other 0.05, rate-limited 0.02; safe to run again 0.64; urgency 1.86 of 3 (soon 0.70, routine 0.22, now 0.08)
     Review: safe to run again 0.64, between 0.20 and 0.80.

[...]

Past due: pending actions whose time has passed (not sent to Jev)

p02  example_search_index_rebuild  6 pending
     Group example-search; scheduled 2026-09-25 20:00 to 2026-09-25 21:40 UTC
     Action IDs: 4192, 4193, 4194, 4195, 4196 and 1 more
     To run them now by hand (printed only): wp action-scheduler run --hooks=example_search_index_rebuild
```

The full outputs are in [`examples/report.txt`](examples/report.txt), [`examples/report.json`](examples/report.json)
and [`examples/dry-run.txt`](examples/dry-run.txt).

## What leaves your machine

Nothing, unless you run the tool with a key and without `--dry-run`. Then it sends POST requests to
`https://api.typesafe.ai/v1/systemone`, and nowhere else. Each request carries:

- your key, in the `Authorization` header;
- the model name, one fixed paragraph saying the state holds groups of failed Action Scheduler actions, and the three
  questions per group shown by `--dry-run`;
- for each failed group: the hook name, the Action Scheduler group names, the error (cleaned, at most 500
  characters), whether the actions are recurring, how often the group failed in words (`once`, `a few times`,
  `dozens of times` and so on), whether the arguments differ between actions, the names and value types of one
  action's arguments (such as `{"order_id": "number", "email": "text"}`, never the values), whether the group failed
  in the last 24 hours of the export, and whether Action Scheduler stopped rescheduling it.

Cleaning happens on your machine before anything is shown or sent. In the error, ids, amounts, dates, times,
numbers, UUIDs, hashes, email addresses, public IP addresses and quoted values that are not identifiers become
placeholders, URL query strings become `?<query>`, user names or passwords in URLs are dropped, server paths are cut
back to the WordPress folder (`wp-content/...`) or to the file name, and PHP stack traces are removed. Control
characters and text-direction marks are removed too, because they could change your terminal when the report prints.

Action IDs, argument values, dates, exact counts, the rest of each log, the past-due actions and anything else on
your machine are not sent. The example arguments in the report hide values under names such as email, phone, name,
address, note, token or key, and any email address, phone number or public IP address in a value; they are printed
on your machine and never sent. The tool makes no other network requests, such as telemetry or update checks.
`--dry-run --json` prints the exact body of every request it would send.

## Limits

- It sees the export and nothing else. It cannot tell whether a remote service is back, whether a payment went
  through, or whether a plugin is active now. Read each group before you run its commands; they are suggestions.
- Grouping can merge two problems that print the same message from the same hook, or split one problem whose
  messages differ in words.
- Names written into an error's free text (outside quotes) are not recognised and are sent as written. Run
  `--dry-run` to see exactly what would be sent.
- Error text can hold words a customer or a remote service wrote. Jev reads the state as data, but such text can
  still move an answer.
- Action Scheduler's own log lines are read in English. On a site in another language the last log line is taken as
  the error, and a stopped recurring schedule is not recognised.
- Every pending action in the input counts as past due, and actions without a `recurring` field count as single
  actions and get retry commands.
- Since Action Scheduler 4.0.0, failed actions are deleted after 3 months by default (the
  `action_scheduler_retention_period_for_failed` filter), so an export holds at most that much history.
- English error messages work best.
- The token counts from `--dry-run` are estimates (one token per three characters). After a run the report shows the
  count TypeSafe returned.
- TypeSafe's notes on jev-1.13 say accuracy falls as the state fills with detail unrelated to a question, and a
  request here can hold about 50 groups. If answers look off, send fewer groups per request with `--batch`.

## Token use

The tool estimates about 1,130 input tokens per group, most of it the text of the three questions. The example's 12
groups are one request of about 13,600 tokens. A test export with 204 distinct groups (1,479 failed actions) was
about 230,000 tokens in 4 requests. Run `--dry-run` first to see the estimate for your own export.

## Development

`npm test` runs 29 tests with Node's test runner. They need no key: a fixture stands in for Jev, and any attempt to
reach the network fails the test. `npm run example` rebuilds the files in `examples/`, and a test checks that they
match the code.

## License

MIT. Made by [Hamza Ahmad Aslam](https://hamzaahmadaslam.com), WordPress and web performance engineer.
