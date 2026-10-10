/** Deterministic request-control changes driven by three recorded todo writes. */
import { installModelSelection } from '@deepseek-ai/dsh-agent'

const ROUTE = { provider: 'controls-fixture', model: 'controlled' }
const CHOICES = [
  { ...ROUTE, reasoningEffort: 'high', serviceTier: 'priority', textVerbosity: 'high' },
  { ...ROUTE, reasoningEffort: 'low', serviceTier: 'priority', textVerbosity: 'high' },
  { ...ROUTE, reasoningEffort: 'low', serviceTier: 'default', textVerbosity: 'low' },
  { provider: ROUTE.provider, model: 'plain' },
]
const selections = new WeakMap()

export const name = 'request-controls-driver'
export const inject = ['agents']

/**
 * Install real selection snapshots and advance only after durable todo writes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Loader composition context.
 */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const selection = { current: CHOICES[0], assembled: undefined, index: 0 }
    selections.set(agent.session, selection)
    installModelSelection(agent.ctx, selection)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'todo/write') return
    const selection = selections.get(session)
    if (selection === undefined) throw new Error('request controls require an installed selection')
    selection.index += 1
    selection.current = CHOICES[selection.index]
    if (selection.current === undefined) throw new Error('request controls received an unexpected todo write')
  })
  // Headless also installs a fixed selection; make this test driver authoritative.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const selected = context.agent === undefined ? undefined : selections.get(context.agent.session)?.assembled
    if (selected === undefined) return assembled
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
  })
  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    const selected = selections.get(agent.session)?.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _effort, serviceTier: _tier, textVerbosity: _verbosity, ...routeConfig } = resolved
    return { ...routeConfig, ...selected }
  })
}
