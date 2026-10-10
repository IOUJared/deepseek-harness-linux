/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, ServiceTier, TextVerbosity } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
  /** Explicit default service tier; omission preserves provider behavior. */
  serviceTier: Volatile<'default' | 'priority' | undefined>
  /** Explicit default output detail; omission preserves provider behavior. */
  textVerbosity: Volatile<'low' | 'medium' | 'high' | undefined>
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: {
  provider: string; model: string; reasoningEffort?: string
  serviceTier?: 'default' | 'priority'; textVerbosity?: 'low' | 'medium' | 'high'
}): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
    ...settings.serviceTier === undefined ? {} : { serviceTier: ServiceTier(settings.serviceTier) },
    ...settings.textVerbosity === undefined ? {} : { textVerbosity: TextVerbosity(settings.textVerbosity) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()

  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
    serviceTier: z.union(['default', 'priority']).volatile(),
    textVerbosity: z.union(['low', 'medium', 'high']).volatile(),
  })

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const reasoningEffort = this.config.reasoningEffort.get()
    const serviceTier = this.config.serviceTier.get()
    const textVerbosity = this.config.textVerbosity.get()
    return selection({
      provider: this.config.provider.get(), model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...serviceTier === undefined ? {} : { serviceTier },
      ...textVerbosity === undefined ? {} : { textVerbosity },
    })
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry. Saves commit in submission order; a failed
   * save rejects its caller without blocking later saves.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const config = {
      provider: next.provider, model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
      ...next.serviceTier === undefined ? {} : { serviceTier: next.serviceTier },
      ...next.textVerbosity === undefined ? {} : { textVerbosity: next.textVerbosity },
    }
    const saved = this.saves.then(() => editor.edit(entry, () => config))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
