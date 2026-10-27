# `host:time`

`host:time` provides the current time, calendar calculations, formatting, sleep, and timeouts that cause interruptions in an Arc run. Arcade makes the module available automatically.

```js
"arc";
import Time from "host:time";

function Main() {
  this.trigger = () => true;

  let now = Num();
  now.$set(Time.nowMillis());
  let label = Str();
  label.$set(Time.format(now, "iso"));
  $instruct(`Include ${label} in the report.`);
}
```

The examples below show statements inside an Arc function with the same import.

## Operations and common inputs

| Operation | Result | Contract |
| --- | --- | --- |
| `Time.$addTimeout(milliseconds, id?)` | No result | Register a timeout due `milliseconds` after the call executes. |
| `Time.$removeTimeout(id)` | No result | Cancel every pending timeout with this ID in the current run. |
| `Time.$sleep(milliseconds)` | No result | Delay further execution until the sleep deadline has passed. |
| `Time.nowMillis()` | `Num` | Current Unix timestamp in integer milliseconds. |
| `Time.offset(ts, offset, timeZone?)` | `Num` | Apply calendar and elapsed-time offsets to `ts`. |
| `Time.startOf(ts, unit, timeZone?)` | `Num` | Start of the period containing `ts`. |
| `Time.format(ts, format, timeZone?)` | `Str` | Render `ts` using a named format or custom pattern. |

Timestamps, timeout durations, and sleep durations use milliseconds. Timestamps must be integers between −8,640,000,000,000,000 and +8,640,000,000,000,000 inclusive. Calendar calculations must also produce a representable date in the selected zone. Negative timestamps represent instants before the Unix epoch, `1970-01-01T00:00:00Z`.

The trailing registration `id` and calendar `timeZone` arguments are optional strings; `$removeTimeout` requires its string `id`. An omitted zone defaults to `UTC`. Supplied zones must be IANA names, such as `Asia/Shanghai` or `America/New_York`; numeric offset zones such as `+08:00` are rejected. Calendar operations use the ISO/Gregorian calendar, and formatting uses English names independently of the machine's local settings.

Read-only operations are available in trigger and action evaluation. `$addTimeout`, `$removeTimeout`, and `$sleep` are available during action evaluation.

Arguments with the wrong type or unsupported struct fields are rejected before the call executes. The time module validates and prepares every call before installing the batch or publishing effects. Invalid values, such as a negative timeout, an unknown time zone or unit, or an unsupported format pattern, reject submission. During action evaluation, the host records poison and returns the ordinary terminal frontier from its current call. The hub then releases the execution. A rejected trigger submission ends that probe.

## Published activity

The module publishes activity through host-module work events. The call event's `publishedData` describes the operation:

| Operation | Published data | Publication rule |
| --- | --- | --- |
| `$sleep` | `{ deadlineMillis }` | The sleep remains unresolved and its timer is installed. |
| `$addTimeout` | `{ deadlineMillis }` | The timeout remains unconsumed and uncancelled and its timer is installed. |
| `$removeTimeout` | `{ removedHostCallIds }` | The call has no admitted effects; the data contains its exact retained cancellation selection, including an empty selection. |
| Read-only operations | None. | No call or effect activity is published. |

Deadlines are absolute Unix milliseconds. Reconstruction republishes outstanding sleeps and timeouts with their original deadlines. The module applies the complete batch's retained removals before choosing deadline publications, so a cancelled historical timeout is not advertised again. A completed historical removal publishes nothing, and later registrations using the same name retain their own deadlines. Failed operations publish no reconstructed activity.

An admitted sleep resolution ends its wait. A timeout's registration resolution completes the authored registration call while its timer remains pending; its later interruption consumes the timeout. A removal's selected IDs identify cancelled timeout occurrences. General event interpretation and run-stop behavior follow [host-module activity semantics](../observability.md#host-module-activity).

## Timeouts and `catchInterruption`

`$addTimeout(milliseconds, id?)` registers a timeout for the current run. The call completes after registration; the run can continue while the timeout is pending. Each call registers an independent timeout, even when several calls share the same ID. An omitted ID becomes the duration's string representation: `$addTimeout(5000)` has ID `"5000"`. Explicit strings, including the empty string, are preserved.

Use `this.interruption.id` in `this.catchInterruption` to match a timeout:

```js
this.catchInterruption = () => this.interruption.id == "review";
Time.$addTimeout(5000, "review");
$instruct("Review the draft.");
```

The timeout becomes due five seconds after registration. Delivery requires active traversal at a handoff that permits an interruption. Closing effects and exclusive transitions defer delivery according to runtime legality. The time module emits the timeout to the hub queue, which can advance the host while a worker runs, waits for an answer, or a sleep remains pending. Cooperative cancellation and resource cleanup follow, so the duration is not a guarantee that external work stops at that exact instant. An interruption does not roll back external actions already performed. Due timeouts are delivered in deadline order, with registration order breaking ties.

Arc's ordinary catch and propagation rules apply. The host consumes a timeout when it issues the interruption, including when catch evaluation later rolls back and poisons the run. The occurrence already exists before the runtime evaluates `catchInterruption`. A catch may need semantic evaluation or allow traversal to continue. Completed and poisoned runs discard their remaining timeouts. Deflected or interrupted runs retain pending timeouts, as do runs paused manually or waiting to continue after a recoverable provider failure.

Timeout durations must be nonnegative safe integers, and adding the duration to the registration time must produce a timestamp within the supported range. A zero-duration timeout becomes due once registration completes.

Pending timeouts survive Arcade restarts and retain their original deadlines, so time spent offline counts toward the delay. Expiry does not start, resume, or reactivate an inactive run. An overdue timeout waits until the run is actively traversed and permits an interruption.

### Removing timeouts

`Time.$removeTimeout(id)` cancels all currently pending timeouts with that exact string ID across nodes in the current run. Use the duration string to remove registrations whose ID was omitted. Explicit IDs, including the empty string, use the same matching rule; an explicit `"1000"` also matches the default ID of a 1,000-millisecond timeout.

```js
Time.$addTimeout(1000);
Time.$addTimeout(1000);
Time.$removeTimeout("1000"); // Removes both pending registrations.

Time.$addTimeout(1000, "review");
Time.$addTimeout(2000, "review");
Time.$removeTimeout("review"); // Removes every pending review timeout.
```

Removal completes successfully without a value, including when no matching timeout remains, it already fired, or it was already removed. Other IDs, sleeps, other runs, and later registrations remain independent. Reusing an ID after removal creates a new timeout that a subsequent removal with that ID can cancel.

A timeout has fired once the time module emits its interruption to the worker hub. Removal leaves that interruption available for runtime admission, even if delivery is deferred, and preserves admitted interruption history. An overdue timeout still in the module's pending list remains cancellable.

The module removes timers during submission and retains the selected occurrence IDs in its setup acknowledgment. It emits an ordinary void resolution through `enqueueModuleEffect`; after setup acknowledgment is committed, the worker hub delivers that resolution through `ArcHostService.advanceAction` to settle the authored call. A no-op removal follows the same completion path. Reconstruction restores the retained selection before checking deadlines, so cancelled registrations stay cancelled after restart.

## `sleep`

`Time.$sleep(milliseconds)` delays further execution in the current run until its deadline has passed. It completes without a result. Other runs can progress while this run sleeps.

```js
this.catchInterruption = () => this.interruption.id == "review";
Time.$addTimeout(1000, "review");
Time.$sleep(5000);
$instruct("Continue reviewing.");
```

Sleep leaves the run waiting for a host module resolution while the hub remains free to deliver other queued inputs. In this example, the timeout can interrupt the unfinished sleep when the runtime permits it. If catch evaluation needs a judgment, a sleep resolution that arrives during that judgment remains pending. A successful catch can resume the same sleep occurrence and admit its resolution exactly once; an uncaught interruption abandons the sleep and its result. Queue order determines admission when worker feedback and host module effects arrive concurrently.

Sleep durations must be nonnegative safe integers, and adding the duration to the call's start time must produce a supported timestamp. Zero is immediately eligible for completion. Scheduling can delay completion beyond the deadline. Sleep uses the same wall clock as timeouts, and clock changes affect when its deadline is reached.

An unfinished sleep survives Arcade restart with its original deadline, so offline time counts. Reconstruction establishes outstanding timers together before emitting overdue results in deadline order. A pause request is cooperative: setup acknowledgment is already durable, while queued operation results wait for permission to advance. Pausing preserves the deadline.

## `offset`

Pass a struct containing any of `years`, `months`, `days`, `hours`, `minutes`, and `seconds`:

```js
let next = Num();
next.$set(Time.offset(0, { days: 1, hours: 2 }));
// next is 93600000: 1970-01-02T02:00:00Z.
```

Missing fields are zero, and `{}` preserves the timestamp. Values through `minutes` must be safe integers. `seconds` also accepts fractions representing whole milliseconds; for example, `{ seconds: 1.001 }` adds 1,001 milliseconds. Additional fields are rejected.

Offsets apply in this order:

1. Combine `years` and `months` into a signed month displacement. Clamp the original day to the destination month's last day; January 31, 2024 plus one month becomes February 29, 2024.
2. Move `days` through the selected zone's local calendar.
3. Add `hours`, `minutes`, and `seconds` as elapsed time.

Positive and negative fields can be combined. Calendar days and elapsed hours differ across daylight-saving changes. Starting at noon on March 9, 2024 in `America/New_York`:

| Offset          | Local result      | Elapsed time |
| --------------- | ----------------- | ------------ |
| `{ days: 1 }`   | March 10 at 12:00 | 23 hours.    |
| `{ hours: 24 }` | March 10 at 13:00 | 24 hours.    |

When a calendar adjustment lands on a local time that occurs twice, it chooses the earlier occurrence. In `America/New_York`, adding one day to November 2, 2024 at 01:30 reaches the first 01:30 on November 3, with offset `-04:00`.

When the intended local time does not exist because the clock moves forward, the result moves forward by that gap. In the same zone, adding one day to March 9, 2024 at 02:30 reaches March 10 at 03:30: the clock skips the intended 02:30.

## `startOf`

`startOf` returns the start of the period containing the supplied timestamp:

```js
let start = Num();
start.$set(Time.startOf(90000000, "day"));
// start is 86400000: 1970-01-02T00:00:00Z.
```

The unit is one of `year`, `month`, `week`, `day`, `hour`, `minute`, or `second`, case-sensitively. Weeks start on Monday. The optional zone determines the local period; an input already at its boundary is unchanged.

Calendar boundaries use the first valid instant of the period. For hours, minutes, and seconds, the result stays in the input's occurrence of that period when clocks repeat. For example, `2024-11-03T01:30:00-05:00` in `America/New_York` belongs to the second 01:00 hour; its hour start is `2024-11-03T01:00:00-05:00`.

Some clock changes occur partway through an hour. In `Australia/Lord_Howe`, the hour containing `2024-04-07T01:45:00+10:30` starts at the repeated period's first instant, `01:30:00+10:30`. A boundary inside a forward clock gap also moves to the first valid instant: the hour containing `2024-10-06T02:45:00+11:00` starts at `02:30:00+11:00`.

## `format`

Pass a named format or custom pattern, with an optional zone:

```js
let label = Str();
label.$set(Time.format(0, "yyyy-MM-dd HH:mm:ss", "Asia/Shanghai"));
// label is "1970-01-01 08:00:00".
```

Whole-string preset names are ASCII case-insensitive:

| Preset           | UTC example                       |
| ---------------- | --------------------------------- |
| `iso`, `rfc3339` | `2026-09-24T12:34:56.000Z`        |
| `rfc5322`        | `Thu, 24 Sep 2026 12:34:56 +0000` |
| `asctime`        | `Thu Sep 24 12:34:56 2026`        |

ISO/RFC 3339 includes milliseconds and `Z` or a numeric offset. RFC 5322 uses a numeric offset. Asctime uses a space-padded day and has no trailing newline or zone field. Presets require years 0000–9999; RFC 5322 additionally requires a year of at least 1900. Formats containing a zone offset reject historical offsets containing seconds rather than rounding them.

Otherwise, the original format string is interpreted as this case-sensitive Unicode-pattern subset:

| Tokens                   | Meaning                                      |
| ------------------------ | -------------------------------------------- |
| `yyyy`                   | Four-digit year, 0000–9999.                  |
| `M`, `MM`, `MMM`, `MMMM` | Numeric, padded, abbreviated, or full month. |
| `d`, `dd`                | Numeric or padded day.                       |
| `EEE`, `EEEE`            | Abbreviated or full weekday.                 |
| `H`, `HH`                | 24-hour clock hour.                          |
| `m`, `mm`, `s`, `ss`     | Minute or second, optionally padded.         |
| `SSS`                    | Three-digit millisecond.                     |
| `XXX`                    | `Z` or signed `HH:MM` offset.                |
| `xx`                     | Signed `HHMM` offset, including `+0000`.     |

Single quotes delimit literal text; doubled quotes emit one quote. Other punctuation is literal. Unsupported alphabetic token runs and unmatched quotes fail. For example, the pattern `yyyy-MM-dd'T'HH:mm:ss` includes a literal `T`. To print a preset name literally, use a quoted pattern such as `"'iso'"`. Zone-free output is display text and cannot uniquely identify an instant during a repeated local period.

## Replay limitations

Treat `host:time` host calls as **not replay-safe** when continuing a run through jump or rewind: replay preserves historical clock values and deadlines, so timing is not relative to when the successor replays the calls. Verification reuses recorded results and interruptions without reading a fresh clock or registering new timeouts.

Jump and rewind give the successor its own pending timeouts at the selected point, retaining their original deadlines. The source run stays unchanged, and creating the successor delivers no interruption. If timeout registration is retained in the replayed prefix but its subsequent interruption is not, the timeout remains pending. An overdue timeout causes an interruption at the first handoff during active traversal that permits one, which may be on a different branch from the recorded interruption. Replaying `$addTimeout(5000)` therefore does not give the successor a fresh five-second interval. A timeout consumed within the retained prefix stays consumed.

Replayed removal uses its recorded occurrence selection. A prefix retaining the removal keeps those registrations cancelled; a prefix ending before removal retains their original deadlines. Later registrations with the same ID remain independent, as do interruptions already emitted when removal originally ran.

A recorded sleep completion replays immediately. If the selected point retains a started sleep without its completion, the successor inherits that sleep's original deadline. The provider restores outstanding sleep and timeout operations together and emits newly due effects in deadline order. A sleep that starts after the retained prefix receives a fresh deadline when it executes. Verification never sleeps or schedules timers.
