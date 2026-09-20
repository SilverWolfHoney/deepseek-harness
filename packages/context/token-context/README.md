---
description: "Opt-in per-step context with the session's token budget, compaction headroom, and cumulative usage, for users and maintainers enabling or tuning the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-token-context

English | [中文](README.zh.md)

## Summary

`dsh-token-context` tells the model how much context it has left. On eligible steps it appends a durable, source-attributed reading with the projected size of the next request, the route's context capacity, the session's cumulative provider usage, and — when the deployment declares one — the headroom left before automatic compaction. Without it the model plans blind: it cannot tell a request that still fits from one about to be condensed, and it learns that history was replaced only from the checkpoint preamble itself. The plugin is opt-in and reads `ctx.tokenMeter`; it makes no model calls and adds no tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin beside `dsh-token-meter` when the model should see its own context budget. Each reading is one additional user-role message in the durable history; schedule it with `refreshIntervalMs` when per-step readings are more than the conversation needs.

### Minimal composition

The meter must be mounted: this plugin reports the `contextPressure` and `tokenUsage` projection units that `dsh-token-meter` registers, and it declares that service as a dependency rather than degrading silently without it.

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-agent'
- name: '@deepseek-ai/dsh-token-context'
  config:
    compactionThresholdRatio: 0.8
```

### Declaring the dependency

A composition that mounts this plugin by bare package name must also list it in the resolver manifest that composition is built from. In a user profile that manifest is the profile's own `package.json`, beside the other plugins the profile installs:

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-token-context": "link:D://dsh-plugins//dsh-token-context"
  }
}
```

The Loader resolves a bare package from every Node root its launcher sees, so a missing entry still activates this plugin and still appends readings. `@deepseek-ai/dsh-plugin-package-inventory-deepseek` is stricter: every official DeepSeek request carries an inventory of the active plugin packages, and that plugin resolves each one from the profile directory alone. An unresolvable manifest fails request preparation, and `dsh-llm-deepseek` reports it as `DeepSeek request extension preparation failed` — a message naming neither this plugin nor the missing manifest. A profile that mounts this package without declaring it therefore fails every turn while the readings keep appearing in the transcript.

On Windows, a `link:` dependency whose target sits on another drive can materialize as a relative symbolic link that cannot be followed. Point a junction at the package directory instead:

```powershell
New-Item -ItemType Junction -Path '<profile>/node_modules/@deepseek-ai/dsh-token-context' -Target '<package directory>'
```

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `refreshIntervalMs` | `0` (every eligible step) | Minimum milliseconds between durable injections in one session |
| `compactionThresholdRatio` | unset (no headroom line) | Fraction of the context window at which this deployment's compaction backend condenses history |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-token-context) is the exhaustive source for every accepted field and its JSDoc.

### When a reading is due

A reading is appended when the step enters and the projection has something factual to report, which requires a provider to have reported usage at least once. The first request of a session therefore carries no reading: `pressureTokens` and `projectedTokens` are absent until a provider reports usage, and `contextWindow` is absent until a route advertises one. A step that the loop rejects gets no reading.

Both fields are optional in the projection, so the plugin reports what it has: without a declared capacity it names the prompt size alone, and without a configured ratio it omits the compaction line entirely.

`compactionThresholdRatio` is the deployment's own compaction point, not a value this plugin can discover. `dsh-compaction-basic` defaults to `0.8` and a profile may override it per route, so a deployment that compacts must state the ratio here too; leaving it unset only removes the headroom line.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the plugin; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The plugin is a prepended `agent/pre-step` listener that delegates first and appends one sourced `UserMessage` when a reading is due. It holds no per-session state of its own beyond one host-only projection unit recording the latest injection time, so the refresh schedule survives resume without a process-local cache.

Reads come from `ctx.sessionProjections.snapshot()`, which serves the schema-validated client view of `contextPressure` and `tokenUsage`. `projectedTokens` — what the next request's prompt would cost — is that view's own anchored figure; recomputing it from the internal state would duplicate the meter's pricing rather than read it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step listener, reading renderer, configuration validation |

### Reading composition

The occupancy line names the projected prompt size, and adds the capacity and a percentage only when the route declared one. The totals line sums the disjoint provider buckets — uncached input plus both cache buckets is the prompt side, and `cacheReadTokens` is reported separately as the cached share. The compaction line is the last and appears only when both a ratio and a capacity are known; when the projected size is already at or past the threshold it says so instead of reporting a negative headroom.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the plugin to the measurement it reports and the sibling clock plugin it follows.

- [Token meter](../../llm/token-meter/README.md) — the replay-aware measurement service and the projection units this plugin reads.
- [Token-meter subsystem](../../../docs/subsystems/token-meter.md) — the measurement semantics behind `ctx.tokenMeter`.
- [Compaction capability](../../compaction/README.md) — the pressure-sensitive consumer that condenses history at the threshold a deployment declares.
- [Time context](../time-context/README.md) — the sibling per-step plugin this one follows for append scheduling and source attribution.
- [Context group map](../README.md) — the other request-context packages.

-----

<a id="model-experience"></a>
## Model Experience

### Context budget reading

#### What the model sees

Each injected message carries the lines the deployment's data supports, in this order. Without a declared capacity the first line reads `<projected> tokens in the next request's prompt.` instead, and without both a configured ratio and a capacity the third line is absent; a projected size at or past the threshold reads `this request is at or past that threshold.` instead of reporting headroom.

##### Supported lines

```markdown
Context budget while preparing turn <turn>, step <step>: <projected> of <window> tokens used (<percent>%).
Session totals: <prompt> prompt tokens (<cached> cached), <output> output tokens.
Automatic compaction is configured near <threshold> tokens: <headroom> tokens of headroom left.
```

#### Token effect

Each reading adds roughly 40–60 tokens to the request and stays in history until compaction shadows it. A positive `refreshIntervalMs` reduces additions; omission or `0` adds one at every eligible step after the first provider usage.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when a context-budget reading is a poor fit or needs special operational care. They are current package constraints, not a general token-accounting comparison or a task backlog.

- **Nothing is reported before the first provider usage** — a session's opening request carries no reading, so the model starts a task without a budget figure.
- **The reading understates its own request** — it is appended during pre-step, so `projectedTokens` prices the request without this reading's own weight.
- **History cost between compactions** — omission or `0` retains one reading for every eligible step; a positive interval reduces but does not eliminate this cost and may leave a later request without a fresh figure.
- **The threshold ratio is declared, not discovered** — the plugin cannot read another deployment's compaction policy, so a mismatched `compactionThresholdRatio` reports headroom against a point that backend does not use.
- **Every due step reads a full projection snapshot** — `snapshot()` serves every client-visible unit; a deployment adding many units pays that cost per step.
- **Figures inherit the meter's heuristic error** — the projected size is anchored to provider usage and the delta since it is estimated at four characters per token, so CJK text and JSON schemas are underpriced.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The injected reading is a pure render of two registered projection units read at one revision, and the plugin's own state is a single timestamp; an independent check could only re-run the same fold, which detects drift by duplicating the implementation rather than by observing a relation that can diverge.
