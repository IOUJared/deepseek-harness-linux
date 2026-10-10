/** Source-plane real profile Loader, exported Session Controller and durable JSONL evidence. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SqliteQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Typert from '@deepseek-ai/dsh-typert-registry'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import Commands from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Workspaces from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionController from '../src/index.ts'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { promptFingerprint } from '../src/prompt-admission.ts'
import { profileComposition } from '../../../settings/settings/tests/profile-composition.ts'

let home: string | undefined
const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  vi.restoreAllMocks()
  if (home !== undefined) {
    const resolved = await realpath(home)
    if (!resolved.startsWith(join(tmpdir(), 'dsh-prompt-loader-'))) throw new Error('unexpected fixture cleanup target')
    await rm(resolved, { recursive: true, force: true })
  }
  home = undefined
})

async function boot(directory: string) {
  const rows = [
    { id: 'typert', name: 'test-typert' },
    { id: 'storage', name: 'test-storage' },
    { id: 'json', name: 'test-json', config: { root: join(directory, 'kv') } },
    { id: 'domain', name: 'test-domain', config: { backend: 'json' } },
    { id: 'credentials', name: 'test-credentials', config: { path: join(directory, 'credentials.yml'), watch: false } },
    { id: 'connection', name: 'test-connection' },
    { id: 'fs', name: 'test-fs', config: { cwd: directory } },
    { id: 'attachments', name: 'test-attachments', config: { dshHome: directory } },
    { id: 'sessions', name: 'test-sessions' },
    { id: 'persistence', name: 'test-persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { id: 'projections', name: 'test-projections' },
    { id: 'query', name: 'test-query', config: { path: join(directory, 'query.sqlite'), openAt: 'never' } },
    { id: 'workspaces', name: 'test-workspaces' },
    { id: 'llm', name: 'test-llm' },
    { id: 'agents', name: 'test-agents' },
    { id: 'prompt', name: 'test-system-prompt' },
    { id: 'tools', name: 'test-tools' },
    { id: 'loop', name: 'test-loop', config: { agents: [] } },
    { id: 'default-model', name: 'test-default-model', config: { provider: 'PUBLIC-provider', model: 'PUBLIC-model' } },
    { id: 'commands', name: 'test-commands' },
    { id: 'files', name: 'test-files' },
    { id: 'controller', name: 'test-controller' },
  ]
  const path = join(directory, 'cordis.yml')
  // JSON is valid YAML; the test-only profile still owns and mounts the complete Loader entry tree.
  await writeFile(path, JSON.stringify(rows) + '\n')
  const ctx = new Context()
  contexts.add(ctx)
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-typert', Typert], ['test-storage', Storage], ['test-json', StorageJson], ['test-domain', StorageDomain],
    ['test-credentials', LocalCredentials], ['test-connection', Connection], ['test-fs', FsLocal],
    ['test-attachments', Attachments], ['test-sessions', SessionStore], ['test-persistence', JsonlPersistence],
    ['test-projections', SessionProjections], ['test-query', SqliteQuery], ['test-workspaces', Workspaces],
    ['test-llm', LlmRuntime], ['test-agents', AgentRegistry], ['test-system-prompt', SystemPrompt],
    ['test-tools', Tools], ['test-loop', AgentLoop], ['test-default-model', AgentDefaultModel],
    ['test-commands', Commands], ['test-files', FileUploads], ['test-controller', SessionController],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(), import: name => Promise.resolve(modules.get(name)),
    register(): never { throw new Error('unexpected source module hook') },
    getOrCreateModuleJob(): never { throw new Error('unexpected source module job') },
    resolveSync(): never { throw new Error('unexpected source module resolver') },
    load(): never { throw new Error('unexpected source module load') },
  }
  ctx.loader.internal = internal
  await profileComposition(ctx, directory, path)
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'controller')
  if (entry?.fiber === undefined) throw new Error('missing Session Controller Loader fiber')
  await entry.fiber.await()
  if (ctx.get('sessionController') === undefined) throw new Error('Session Controller did not activate')
  return ctx
}

function request(id: string): SessionPromptRequest {
  return { sessionId: SessionId(`PUBLIC-${id}`), requestId: brandString<SessionRequestId>(`PUBLIC-request-${id}`),
    mode: 'queue', content: [{ type: 'text', text: 'PUBLIC original intent' }] }
}

async function storeClaimedGap(ctx: Context, raw: SessionPromptRequest, directory: string, legacy = false) {
  const header: SessionHeader = { id: raw.sessionId, version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: directory, isSeeded: false }
  const message = createUserMessage({ content: [{ type: 'text', text: 'PUBLIC original intent' }],
    source: { kind: 'user', rpcId: raw.requestId, ...legacy ? {} : { promptFingerprint: promptFingerprint(raw) } } })
  const events: SessionEvent[] = [
    { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] } },
    { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  ]
  await using handle = await ctx.sessionPersistence.create(header)
  await handle.append(events)
  await handle.flush()
  return { message, events }
}

describe('prompt admission through the exported source profile Loader', () => {
  it('reads a claimed-before-history durable gap without Agent activation or writes, then joins an exact resend', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-prompt-loader-'))
    const ctx = await boot(home)
    const raw = request('restart')
    const { message, events } = await storeClaimedGap(ctx, raw, home)
    const create = vi.spyOn(ctx.agentLoop, 'create')
    const resume = vi.spyOn(ctx.agentLoop, 'resume')
    const provider = vi.spyOn(ctx.llm, 'resolveModelInfo')
    const importer = vi.spyOn(ctx.attachments, 'admitPromptContent')
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    expect(ctx.agents.get(raw.sessionId)).toBeUndefined()
    expect(ctx.sessions.get(raw.sessionId)).toBeUndefined()
    expect(await ctx.sessionController.promptAdmission(raw, new AbortController().signal)).toEqual({
      state: 'accepted', evidence: 'journal', phase: 'admitted', messageId: message.id, seq: 0,
    })
    expect(await ctx.sessionController.promptAdmission(request('absent'), new AbortController().signal)).toEqual({ state: 'unknown' })
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    expect(open.mock.calls.every(([_id, access]) => access === 'read')).toBe(true)
    expect(ctx.agents.get(raw.sessionId)).toBeUndefined()
    expect(ctx.sessions.get(raw.sessionId)).toBeUndefined()
    const first = ctx.sessionController.prompt(raw, new AbortController().signal)
    const duplicate = ctx.sessionController.prompt(raw, new AbortController().signal)
    expect(duplicate).toBe(first)
    await expect(first).resolves.toEqual({ accepted: true })
    await expect(ctx.sessionController.prompt({ ...raw, mode: 'steer' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/prompt-conflict', details: { reason: 'PAYLOAD_CHANGED' } })
    expect(importer).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    const agent = ctx.agents.get(raw.sessionId)
    expect(agent?.inbox.nextTurn).toEqual([])
    expect(agent?.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced' || event.type === 'user/message')).toEqual(events)
    await ctx.fiber.dispose()
    contexts.delete(ctx)
    const restarted = await boot(home)
    expect(await restarted.sessionController.promptAdmission(raw, new AbortController().signal)).toMatchObject({
      state: 'accepted', evidence: 'journal', phase: 'admitted', seq: 0,
    })
    expect(restarted.agents.get(raw.sessionId)).toBeUndefined()
  })

  it('reports predecessor acceptance but refuses to establish equal payload without its persisted digest', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-prompt-loader-'))
    const ctx = await boot(home)
    const raw = request('legacy')
    const { events } = await storeClaimedGap(ctx, raw, home, true)
    expect(await ctx.sessionController.promptAdmission(raw, new AbortController().signal)).toMatchObject({ state: 'accepted', phase: 'admitted' })
    await expect(ctx.sessionController.prompt(raw, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/prompt-conflict', details: { reason: 'PAYLOAD_UNVERIFIABLE' },
    })
    expect(ctx.agents.get(raw.sessionId)?.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced' || event.type === 'user/message')).toEqual(events)
  })
})
