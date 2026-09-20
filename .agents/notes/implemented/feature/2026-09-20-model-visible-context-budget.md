# Agent Note: Model-visible context budget

Status: implemented

English | [中文](2026-09-20-model-visible-context-budget.zh.md)

## Problem

The meter measures a session's context pressure, but every consumer of that measurement faces a human. `dsh-token-meter` registers `tokenUsage`, `contextPressure`, and `contextBreakdown` for client carriers, and its only host consumer is the compaction backend. A model planning its next step therefore cannot see how much room it has left: it cannot tell whether one more file read still fits, and it learns that history was replaced only from the checkpoint preamble that announces the result.

That gap is sharpest at compaction. The pressure check fires at a configured fraction of the window, and the summarizer is instructed not to mention that the context was compacted, so the model resumes from a shortened history with no durable record of what was dropped or how much room remains. The consequence is not an accounting error but a planning one: the model chooses between reading a file and delegating on evidence it does not have.

This note extends the [replay token meter service](../../archived/architecture/2026-07-15-replay-token-meter-service.md) and the [projected token usage and request context](../architecture/2026-07-29-projected-token-usage-and-request-context.md) decisions, which own the measurement and its `projectedTokens` field. It does not reverse the meter's own decision that occupancy is a reference figure rather than a billing record: the harness still makes no decision from it, and this plugin only makes the reference visible to the one actor that plans with it.

## Decision

### The budget reading is appended context, not a tool

`@deepseek-ai/dsh-token-context` registers a prepended `agent/pre-step` listener that appends one sourced `UserMessage` per eligible step, following [time-context](../../archived/feature/2026-07-14-time-context-plugin.md) for append scheduling and source attribution. A tool was rejected: the model's remaining room is continuous state that changes every step, so a tool would cost a round trip per question and would report only when the model already suspected it needed to ask. An appended reading arrives with the step it describes.

The reading carries only facts the projections actually hold. The occupancy line names `projectedTokens` and adds the capacity and a percentage when the route declared one; the totals line sums the disjoint provider buckets; the compaction line appears only when the deployment declared a ratio and the route declared a capacity. A step with no provider usage yet appends nothing rather than a reading full of placeholders.

### The meter is a hard dependency

The plugin declares `tokenMeter` in its `inject` list. That service's own `apply` registers the three projection units this plugin reads, so injecting it is what makes them present; a composition without the meter has nothing to report and must not mount this plugin and then quietly add no context. The listener still refuses a missing unit loudly, because a unit that vanishes after activation means the composition broke rather than that the step had nothing to say.

### The compaction threshold is declared by the deployment

`compactionThresholdRatio` is configuration, not a discovered value. The plugin cannot read another plugin's compaction policy, and `dsh-compaction-basic` defaults to `0.8` while allowing a profile to override it per route. Following that default here would report headroom against a point a reconfigured deployment does not use, so the field is unset by default and omitting it only removes the compaction line.

## Alternatives considered

**Let the meter supply the reading.** Rejected: `dsh-token-meter` is a measurement service with no session-scoped scheduling, and its own contract is that it adds no prompt, message, schema, tool, or model call. A consumer that owns the append policy keeps the meter replayable and consumer-free.

**Read `measure()` instead of the projection units.** Rejected: `measure()` returns request-and-response pressure, while the question the model asks is what the *next* request will cost. `projectedTokens` is the meter's own anchored answer to that question, and recomputing it from internal state would duplicate the meter's pricing rather than read it.

**Inject at every change instead of every step.** Rejected: the model reads the budget while choosing the step, so a reading suppressed because the number moved little is stale exactly when it matters. Deployments that want fewer readings set `refreshIntervalMs`.

**Make the meter optional and skip silently.** Rejected: a plugin whose only output is the reading would then be indistinguishable from a working one while adding nothing.

## Consequences

Each reading adds roughly 40–60 tokens to the request and stays in history until compaction shadows it, which is additional cost this plugin introduces in exchange for the model's ability to plan. A deployment mounting it on a long-session profile should expect that trade and may schedule readings with `refreshIntervalMs`.

The reading understates its own request: it is appended during pre-step, so `projectedTokens` prices the request without this reading's weight. The figures also inherit the meter's fixed estimator for everything after the last provider sample, so CJK text and JSON schemas are underpriced.

Nothing enforces that the model uses the reading. It makes a figure available that was previously unavailable, and whether that changes an agent's choices is a behavioral question the composition cannot answer for it.
