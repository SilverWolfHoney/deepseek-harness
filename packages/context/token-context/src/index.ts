/**
 * Opt-in request budget context. Eligible steps add durable, source-attributed
 * readings of the session's context occupancy to the request history so the
 * model can see how much room it has left.
 *
 * @module @deepseek-ai/dsh-token-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'token-context'

/**
 * The pre-step registry, the projection registry, and the meter.
 *
 * `tokenMeter` is a required dependency rather than an optional one: its
 * `apply` registers the `contextPressure` and `tokenUsage` units this plugin
 * reports, so a composition without it has nothing to read and this plugin
 * would silently add no context at all.
 */
export const inject = ['agents', 'sessionProjections', 'tokenMeter']

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Scheduling state for this plugin's durable injections. */
    tokenContext: TokenContextProjection
  }
}

const tokenContextStateSchema = zod.object({
  /** Time of this plugin's latest durable injection, or null. */
  lastInjectionTime: zod.number().nullable(),
})

/** Folded token-context scheduling state. */
type TokenContextProjection = zod.infer<typeof tokenContextStateSchema>

/** Request-budget reporting and append scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject at every eligible step. */
  refreshIntervalMs?: number
  /**
   * Fraction of the context window at which this deployment's compaction
   * backend condenses history. When set, each reading also reports the
   * headroom left before that threshold, which is the number that decides
   * whether the current approach still fits.
   */
  compactionThresholdRatio?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  refreshIntervalMs: z.number(),
  compactionThresholdRatio: z.number(),
})

/** One reading's inputs, all read from a single projection revision. */
interface Reading {
  turn: number
  step: number
  pressure: ContextPressureProjection
  usage: TokenUsageProjection
  compactionThresholdRatio: number | undefined
}

/** Prompt-side tokens the provider billed across the session: uncached input plus both cache buckets. */
function promptTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Render the occupancy line; without a declared capacity only the prompt size is known. */
function occupancyLine(reading: Reading, projected: number): string {
  const prefix = `Context budget while preparing turn ${String(reading.turn)}, step ${String(reading.step)}: `
    + String(projected)
  const contextWindow = reading.pressure.contextWindow
  if (contextWindow === undefined) return `${prefix} tokens in the next request's prompt.`
  const percent = Math.round((projected / contextWindow) * 100)
  return `${prefix} of ${String(contextWindow)} tokens used (${String(percent)}%).`
}

/** Render the deployment-configured compaction threshold and the headroom left before it. */
function compactionLine(reading: Reading, projected: number): string | undefined {
  const ratio = reading.compactionThresholdRatio
  const contextWindow = reading.pressure.contextWindow
  if (ratio === undefined || contextWindow === undefined) return undefined
  const threshold = Math.floor(contextWindow * ratio)
  if (projected >= threshold) {
    return `Automatic compaction is configured near ${String(threshold)} tokens: this request is at or past that threshold.`
  }
  return `Automatic compaction is configured near ${String(threshold)} tokens: ${String(threshold - projected)} tokens of headroom left.`
}

/**
 * Render one durable reading, or `undefined` when no provider has reported
 * usage yet and there is nothing factual to report.
 */
function renderReading(reading: Reading): string | undefined {
  const lines: string[] = []
  const projected = reading.pressure.projectedTokens
  if (projected !== undefined) lines.push(occupancyLine(reading, projected))
  const prompt = promptTokens(reading.usage)
  if (prompt > 0 || reading.usage.outputTokens > 0) {
    lines.push(
      `Session totals: ${String(prompt)} prompt tokens `
      + `(${String(reading.usage.cacheReadTokens)} cached), `
      + `${String(reading.usage.outputTokens)} output tokens.`,
    )
  }
  if (lines.length === 0) return undefined
  if (projected !== undefined) {
    const compaction = compactionLine(reading, projected)
    if (compaction !== undefined) lines.push(compaction)
  }
  return lines.join('\n')
}

/** Reject refresh intervals that cannot represent an exact elapsed-millisecond threshold. */
function validateRefreshInterval(refreshIntervalMs: number | undefined): void {
  if (refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(refreshIntervalMs)
    || refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `token-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

/** Reject threshold ratios that cannot name a point inside the context window. */
function validateThresholdRatio(ratio: number | undefined): void {
  if (ratio !== undefined && (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1)) {
    throw new TypeError(
      `token-context: compactionThresholdRatio must be above 0 and at most 1, got ${String(ratio)}`,
    )
  }
}

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - durable refresh scheduling and the optional compaction threshold.
 * @throws when the refresh interval or threshold ratio is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const refreshIntervalMs = config.refreshIntervalMs
  const compactionThresholdRatio = config.compactionThresholdRatio
  validateRefreshInterval(refreshIntervalMs)
  validateThresholdRatio(compactionThresholdRatio)

  ctx.sessionProjections.register({
    key: 'tokenContext',
    stateVersion: 1,
    stateSchema: tokenContextStateSchema,
    init: () => ({ lastInjectionTime: null }),
    apply: (state, event) => {
      if (event.type !== 'user/message') return state
      const injected = event.data.source.kind === 'plugin' && event.data.source.plugin === name
      return injected ? { ...state, lastInjectionTime: event.time } : state
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0) {
      const now = Date.now()
      const scheduling = ctx.sessionProjections.stateOf(agent.session, 'tokenContext')
      if (scheduling === undefined) {
        throw new Error('token-context: its own scheduling projection unit is not registered')
      }
      const { lastInjectionTime } = scheduling
      if (lastInjectionTime !== null
        && now >= lastInjectionTime
        && now - lastInjectionTime < refreshIntervalMs) return decision
    }
    const { contextPressure, tokenUsage } = ctx.sessionProjections.snapshot(agent.session).values
    // The meter's `apply` registers both units, so a missing one means the
    // composition is wrong rather than that this step has nothing to report.
    if (contextPressure === undefined || tokenUsage === undefined) {
      throw new Error(
        'token-context: the token-meter contextPressure and tokenUsage projection units are not registered',
      )
    }
    const text = renderReading({
      turn,
      step,
      pressure: contextPressure,
      usage: tokenUsage,
      compactionThresholdRatio,
    })
    if (text === undefined) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
