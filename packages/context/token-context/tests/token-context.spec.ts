import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as tokenContext from '@deepseek-ai/dsh-token-context'
import type { Config } from '@deepseek-ai/dsh-token-context'

const BASE = Date.parse('2026-07-14T00:00:00.000Z')
const SIGNAL = new AbortController().signal

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(BASE)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(tokenContext, config)
  return ctx
}

function sessionAgent(session: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('token-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Drive one pre-step waterfall the way the loop does, committing entered messages. */
async function fire(ctx: Context, agent: Agent, turn: number, step: number): Promise<void> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'request proposal' }],
    source: { kind: 'plugin', plugin: 'token-context-test' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message === proposed) continue
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

/** The text of every reading this plugin appended to one session. */
function readings(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'token-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

/** Append the durable route-capacity record the loop writes before a request. */
function recordContext(session: Session, contextWindow?: number): void {
  session.append('request/context', {
    provider: 'mock',
    model: 'mock',
    ...contextWindow === undefined ? {} : { contextWindow },
  })
}

/** Append one finalized assistant settlement carrying its provider usage. */
function recordUsage(session: Session, usage: TokenUsage, turn: number, step: number): void {
  session.append('assistant/message', {
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' })
}

/** A session whose next reading has one usage sample and one recorded capacity. */
function measuredSession(ctx: Context, contextWindow = 200_000): Session {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'turn 1' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  recordContext(session, contextWindow)
  recordUsage(session, {
    inputTokens: 400,
    outputTokens: 30,
    cacheReadTokens: 900,
    cacheWriteTokens: 100,
  }, 1, 1)
  return session
}

describe('durable budget context', () => {
  it('appends one snapshot-form reading with the projection figures', async () => {
    const ctx = await mount()
    const session = measuredSession(ctx)

    await fire(ctx, sessionAgent(session), 1, 2)

    const [text] = readings(session)
    expect(text).toBeDefined()
    expect(text).toMatch(
      /^Context budget while preparing turn 1, step 2: \d+ of 200000 tokens used \(\d+%\)\.\n/,
    )
    expect(text).toContain('Session totals: 1400 prompt tokens (900 cached), 30 output tokens.')
    const event = session.snapshotEvents().at(-1)
    expect(event?.type).toBe('user/message')
    if (event?.type !== 'user/message') throw new Error('missing token context')
    // The reading is a `snapshot`-form context: one named contribution whose text
    // is exactly what the model read, so a consumer attributes it without
    // re-splitting prose.
    expect(event.data.source).toEqual({
      kind: 'plugin',
      plugin: 'token-context',
      form: 'snapshot',
      sections: [{ name: 'token-context', text }],
    })
    expect(event.surfaceOp).toBe('append')
  })

  it('names only the prompt size when the route declares no capacity', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create()
    recordContext(session)
    recordUsage(session, { inputTokens: 10, outputTokens: 2 }, 1, 1)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(readings(session)[0]).toMatch(
      /^Context budget while preparing turn 1, step 2: \d+ tokens in the next request's prompt\.\n/,
    )
  })

  it('adds nothing before any provider reports usage', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create()
    recordContext(session, 200_000)

    await fire(ctx, sessionAgent(session), 1, 1)

    expect(readings(session)).toEqual([])
  })

  it('reports the compaction threshold and its headroom when the deployment configures one', async () => {
    const ctx = await mount({ compactionThresholdRatio: 0.8 })
    const session = measuredSession(ctx)

    await fire(ctx, sessionAgent(session), 1, 2)

    const [text] = readings(session)
    expect(text).toMatch(
      /\nAutomatic compaction is configured near 160000 tokens: \d+ tokens of headroom left\.$/,
    )
  })

  it('reports that the request is past the threshold instead of a negative headroom', async () => {
    const ctx = await mount({ compactionThresholdRatio: 0.000001 })
    const session = measuredSession(ctx)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(readings(session)[0]).toContain(
      'Automatic compaction is configured near 0 tokens: this request is at or past that threshold.',
    )
  })

  it('omits the compaction line when the deployment configures no threshold', async () => {
    const ctx = await mount()
    const session = measuredSession(ctx)

    await fire(ctx, sessionAgent(session), 1, 2)

    expect(readings(session)[0]).not.toContain('Automatic compaction')
  })

  it('appends at every eligible step when no refresh interval is configured', async () => {
    const ctx = await mount()
    const session = measuredSession(ctx)
    const agent = sessionAgent(session)

    await fire(ctx, agent, 1, 2)
    await fire(ctx, agent, 1, 3)

    expect(readings(session)).toHaveLength(2)
  })

  it('suppresses a reading inside the configured refresh interval and resumes after it', async () => {
    const ctx = await mount({ refreshIntervalMs: 60_000 })
    const session = measuredSession(ctx)
    const agent = sessionAgent(session)

    await fire(ctx, agent, 1, 2)
    vi.setSystemTime(BASE + 30_000)
    await fire(ctx, agent, 1, 3)
    vi.setSystemTime(BASE + 61_000)
    await fire(ctx, agent, 1, 4)

    const texts = readings(session)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('step 2')
    expect(texts[1]).toContain('step 4')
  })

  it('logs no reading for a rejected step', async () => {
    const ctx = await mount()
    const session = measuredSession(ctx)
    const agent = sessionAgent(session)
    const proposed = createUserMessage({
      content: [{ type: 'text', text: 'rejected' }],
      source: { kind: 'plugin', plugin: 'token-context-test' },
    })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [proposed], turn: 1, step: 2, signal: SIGNAL },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'test rejection' }),
    )

    expect(decision.kind).toBe('reject')
    expect(readings(session)).toEqual([])
  })

  it('keeps the injected reading in the request history rather than the request header', async () => {
    const ctx = await mount()
    const session = measuredSession(ctx)

    await fire(ctx, sessionAgent(session), 1, 2)

    const headers = session.snapshotEvents().filter(event => event.type === 'request/header')
    expect(JSON.stringify(headers)).not.toContain('Context budget while preparing')
  })
})

describe('configuration validation', () => {
  it.each([
    ['a negative refresh interval', { refreshIntervalMs: -1 }],
    ['a fractional refresh interval', { refreshIntervalMs: 1.5 }],
    ['a zero threshold ratio', { compactionThresholdRatio: 0 }],
    ['a threshold ratio above one', { compactionThresholdRatio: 1.5 }],
  ] as const)('rejects %s at load', async (_label, config) => {
    await expect(mount(config)).rejects.toThrow(TypeError)
  })

  it.each([
    ['an omitted interval', {}],
    ['a zero interval', { refreshIntervalMs: 0 }],
    ['a full threshold ratio', { compactionThresholdRatio: 1 }],
  ] as const)('accepts %s', async (_label, config) => {
    await expect(mount(config)).resolves.toBeDefined()
  })
})
