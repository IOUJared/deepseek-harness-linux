/** Host BFF entry and Loader shell for the Remote contribution assembly. */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  TypertRemoteEventBuffer,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// The owner packages' client-safe `./types` exports carry the cordis `Events`
// declarations for every allowlisted event. Pulling them into this face is what
// makes the shape assertion below judge real signatures rather than an empty
// event vocabulary.
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-goal/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'

/** Required Host service: the Gateway owns the physical Remote stream mux. */
export const inject = ['typertGateway']

/** Host plugin body registering this application's selected Cordis event source. */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), { home: homedir() }),
    'api-remotes: forwarded Cordis event source',
  )
}

/** Create the sole queue and listener set consumed by the registered Gateway. */
function remoteEventSource(ctx: Context): TypertRemoteEventSource {
  return (_signal, queue) => {
    const disposers = API_REMOTE_FORWARDED_EVENTS.map(({ event, mode }) => {
      if (mode === 'emit') {
        return ctx.on(event as never, ((...args: unknown[]) => {
          queue.push({ event, args: assertJsonArgs(event, args) })
        }) as never)
      }
      return ctx.on(event as never, (function (
        this: unknown,
        request: object,
        next: () => unknown,
      ) {
        const carrierAgent = carrierKeyOf(this)
        if (carrierAgent === undefined) return next()
        const agent = (request as { readonly agent?: Agent }).agent
        if (agent === undefined || agent !== carrierAgent) {
          throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} must carry its Agent directly`)
        }
        return forwardWaterfall(
          queue,
          event,
          request,
          { value: agent.ctx, subject: agent, agentId: agent.id },
          next,
        )
      }) as never)
    })
    return queue.iterate(() => {
      for (const dispose of disposers) dispose()
    })
  }
}

/** Bridge one Cordis waterfall listener through the Gateway-owned pending event. */
function forwardWaterfall(
  queue: TypertRemoteEventBuffer,
  event: string,
  request: object,
  context: TypertRemoteEventInvocation['context'],
  next: () => unknown,
): Promise<unknown> {
  const settled = Promise.withResolvers<unknown>()
  const dispatch: TypertRemoteEventInvocation = {
    event,
    request,
    context,
    resolve: (outcome: TypertRemoteEventOutcome) => {
      if (outcome.kind === 'result') {
        settled.resolve(outcome.value)
        return
      }
      void Promise.resolve().then(next).then(settled.resolve, settled.reject)
    },
    reject: settled.reject,
  }
  if (!queue.push(dispatch)) void Promise.resolve().then(next).then(settled.resolve, settled.reject)
  return settled.promise
}

/** Reject an allowlisted event whose runtime arguments are not lossless JSON data. */
function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}
