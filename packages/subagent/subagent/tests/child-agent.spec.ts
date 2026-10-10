import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, ServiceTier, TextVerbosity } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildAgentOptions } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits selected controls only on the unchanged parent route', () => {
    const parent = parentAgent()
    parent.options.serviceTier = ServiceTier('priority')
    parent.options.textVerbosity = TextVerbosity('low')
    expect(resolveChildAgentOptions(parent, undefined, 1)).toMatchObject({ serviceTier: 'priority', textVerbosity: 'low' })
    const switched = resolveChildAgentOptions(parent, { model: 'child-model' }, 1)
    expect(switched).not.toHaveProperty('serviceTier')
    expect(switched).not.toHaveProperty('textVerbosity')
    expect(resolveChildAgentOptions(parent, {
      model: 'child-model', serviceTier: ServiceTier('default'), textVerbosity: TextVerbosity('high'),
    }, 1)).toMatchObject({ serviceTier: 'default', textVerbosity: 'high' })
  })

  it('uses logged controls and removes creation-time controls omitted from the latest request', () => {
    const parent = parentAgent()
    parent.options.serviceTier = ServiceTier('priority')
    parent.options.textVerbosity = TextVerbosity('low')
    parent.session.append('request/header', {
      header: { config: { provider: 'parent-provider', model: 'parent-model', textVerbosity: TextVerbosity('medium') } },
      reason: 'initial',
    })
    const child = resolveChildAgentOptions(parent, undefined, 1)
    expect(child).not.toHaveProperty('serviceTier')
    expect(child.textVerbosity).toBe('medium')
  })

  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})
