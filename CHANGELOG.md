# Changelog

## Unreleased

- Actions whose export left out `args` no longer get retry commands. Before, the commands were written without
  arguments, which would run the actions with the wrong data. Their groups are no longer described, in the report
  or to Jev, as having the same arguments every time.
- At `--threshold 0.5`, a yes/no answer of exactly 0.5 sends the group to review instead of listing it as safe to
  retry.
- An answer from TypeSafe that is not valid JSON, or that times out while it is read, ends with a one-line TypeSafe
  error. An answer whose `answers` is null is an error too, as a missing one already was, instead of a report with
  every group in review. An invalid-request error prints on one line however TypeSafe lays out its body.
- A retry waits at most a minute, whatever `retry-after` asks for.
- A report that cannot be written, as on a full disk, ends with an error and exit code 1 instead of exit code 0.
- A numeric date too large for JavaScript is read as no date instead of stopping the run.
- CI runs the tests on Node 20, 22 and 24.

## 1.0.0 (2026-09-26)

First release.
