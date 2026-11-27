// Host-half tests: run with `node test/host.test.mjs` (no DSH process needed).
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, access, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __test,
  deleteSession
} from '../lib/index.js'

const {
  DeleteError,
  encodeSegment,
  projectKey,
  sessionDirectory,
  sessionsRoot
} = __test

// ── path encoding ───────────────────────────────────────────────────────────

assert.equal(encodeSegment('session-1'), 'session-1')
assert.equal(encodeSegment('a/b'), 'a~002Fb')
assert.equal(encodeSegment('.'), '~002E')

assert.equal(
  projectKey('/Users/baai/Documents/deepseek-harness/default-workspace'),
  '--Users-baai-Documents-deepseek-harness-default-workspace--'
)
assert.equal(projectKey('C:\\work\\x'), '--C-work-x--')

const root = '/tmp/dsh-sessions'
assert.equal(
  sessionDirectory(root, { cwd: '/Users/baai/x' }, 'session-1'),
  join(root, '--Users-baai-x--', 'session-1')
)
assert.equal(sessionDirectory(root, { cwd: undefined }, 'session-1'), join(root, '_no-cwd', 'session-1'))
// Path traversal is neutralized by segment encoding rather than rejected.
assert.equal(
  sessionDirectory(root, { cwd: '/a' }, '../../etc'),
  join(root, '--a--', '..~002F..~002Fetc')
)

// sessionsRoot honours explicit config and DSH_HOME.
assert.equal(sessionsRoot({ sessionsRoot: '/custom/root' }), '/custom/root')
assert.ok(sessionsRoot({}).endsWith('/sessions'))

// ── fixtures ────────────────────────────────────────────────────────────────

const home = await mkdtemp(join(tmpdir(), 'dsh-ad-home-'))
const sessions = join(home, 'sessions')
const cwd = '/Users/baai/Documents/demo'
const sessionId = 'session-11111111-2222-3333-4444-555555555555'
const dir = sessionDirectory(sessions, { cwd }, sessionId)
await mkdir(dir, { recursive: true })
await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'stub')

function makeScoped(overrides = {}) {
  const cleaned = []
  const registry = {
    archivedSessionIds: [sessionId],
    list() {
      return [
        {
          sessionIds: [sessionId],
          async detachSession(id) {
            cleaned.push(['detach', id])
            this.sessionIds = this.sessionIds.filter((value) => value !== id)
          }
        }
      ]
    },
    async unarchiveSession(id) {
      cleaned.push(['unarchive', id])
      this.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id)
    },
    ...overrides.registry
  }
  const persistence = {
    async stat(id) {
      if (id !== sessionId) return undefined
      return { header: { id, cwd } }
    },
    async open() {
      return { close: async () => {} }
    },
    ...overrides.persistence
  }
  return {
    cleaned,
    registry,
    persistence,
    agents: overrides.agents ?? { get: () => undefined },
    sessions: overrides.sessions,
    get(name) {
      if (name === 'agents') return this.agents
      if (name === 'sessionPersistence') return this.persistence
      if (name === 'sessions') return this.sessions
      return undefined
    },
    workspaceRegistry: registry,
    sessionPersistence: persistence
  }
}

// ── happy path ──────────────────────────────────────────────────────────────

{
  const scoped = makeScoped()
  const result = await deleteSession(scoped, sessionId, {
    sessionsRoot: sessions,
    dshHome: home
  })
  assert.deepEqual(result, { sessionId, removed: true })
  await assert.rejects(access(dir), /ENOENT/)
  assert.deepEqual(scoped.cleaned, [
    ['detach', sessionId],
    ['unarchive', sessionId]
  ])
}

// ── deletes a visible, non-archived session directly ────────────────────────

{
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'stub')
  const scoped = makeScoped({ registry: { archivedSessionIds: [] } })
  const result = await deleteSession(scoped, sessionId, {
    sessionsRoot: sessions,
    dshHome: home
  })
  assert.deepEqual(result, { sessionId, removed: true })
  await assert.rejects(access(dir), /ENOENT/)
}

// ── rejects an unknown session id ──────────────────────────────────────────

{
  const scoped = makeScoped({
    registry: { archivedSessionIds: [] },
    persistence: { stat: async () => undefined },
    sessions: undefined
  })
  await assert.rejects(
    deleteSession(scoped, sessionId, { sessionsRoot: sessions, dshHome: home }),
    (error) => error instanceof DeleteError && error.code === 'not-found'
  )
}

// ── refuses a running session ───────────────────────────────────────────────

{
  const scoped = makeScoped({ agents: { get: (id) => (id === sessionId ? { id, status: 'running' } : undefined) } })
  await assert.rejects(
    deleteSession(scoped, sessionId, { sessionsRoot: sessions, dshHome: home }),
    (error) => error instanceof DeleteError && error.code === 'active'
  )
}

// ── unloads an idle resident Agent, then deletes ────────────────────────────

{
  let live = {
    id: sessionId,
    status: 'idle',
    scope: {
      dispose: async () => {
        live = undefined
      }
    }
  }
  const agents = { get: (id) => (id === sessionId ? live : undefined) }
  const scoped = makeScoped({ agents })
  const result = await deleteSession(scoped, sessionId, {
    sessionsRoot: sessions,
    dshHome: home
  })
  assert.equal(result.removed, true)
  assert.equal(live, undefined)
  assert.deepEqual(scoped.cleaned, [
    ['detach', sessionId],
    ['unarchive', sessionId]
  ])
}

// ── detaches a live Session-store entry so the row cannot reappear ──────────

{
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'stub')
  let detached = 0
  const store = new Map([
    [sessionId, { detach: () => { detached += 1; store.delete(sessionId) } }]
  ])
  const scoped = makeScoped({ sessions: { store } })
  const result = await deleteSession(scoped, sessionId, {
    sessionsRoot: sessions,
    dshHome: home
  })
  assert.equal(result.removed, true)
  assert.equal(detached, 1)
  assert.equal(store.has(sessionId), false)
}

// A rejected write claim leaves the live row, disk log and registry alone.
{
  await mkdir(dir, { recursive: true })
  const owned = Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' })
  let detached = 0
  const store = new Map([[sessionId, { detach: () => { detached += 1 } }]])
  const scoped = makeScoped({
    sessions: { store },
    persistence: { open: async () => { throw owned } }
  })
  await assert.rejects(
    deleteSession(scoped, sessionId, { sessionsRoot: sessions, dshHome: home }),
    { status: 423, code: 'locked' }
  )
  assert.equal(detached, 0)
  assert.ok(store.has(sessionId))
  assert.deepEqual(scoped.cleaned, [])
  await access(dir)
}

// If the durable marker cannot be written, no log or registry state changes.
{
  const alternateHome = join(home, 'blocked-marker')
  await mkdir(alternateHome)
  await writeFile(join(alternateHome, 'storages'), 'not a directory')
  const scoped = makeScoped()
  await assert.rejects(
    deleteSession(scoped, sessionId, { sessionsRoot: sessions, dshHome: alternateHome }),
    { code: 'ENOTDIR' }
  )
  await access(dir)
  assert.deepEqual(scoped.cleaned, [])
}

// A concurrent request cannot quiesce or detach the same session twice.
{
  const options = { sessionsRoot: sessions, dshHome: home }
  let cancelled = 0
  let detached = 0
  let enterDispose
  let finishDispose
  const started = new Promise((resolve) => { enterDispose = resolve })
  const release = new Promise((resolve) => { finishDispose = resolve })
  const agent = {
    status: 'idle',
    cancel() { cancelled += 1 },
    scope: { async dispose() { enterDispose(); await release } }
  }
  const store = new Map([[sessionId, { detach: () => { detached += 1 } }]])
  const scoped = makeScoped({ agents: new Map([[sessionId, agent]]), sessions: { store } })
  const first = deleteSession(scoped, sessionId, options)
  await started
  try {
    await assert.rejects(deleteSession(scoped, sessionId, options), { status: 409, code: 'busy' })
    assert.equal(cancelled, 1)
    assert.equal(detached, 0)
  } finally {
    finishDispose()
    await first
  }
  assert.equal(detached, 1)
}

// ── idempotent cleanup when the log is already gone ─────────────────────────

{
  const scoped = makeScoped({ persistence: { stat: async () => undefined } })
  const result = await deleteSession(scoped, sessionId, {
    sessionsRoot: sessions,
    dshHome: home
  })
  assert.deepEqual(result, { sessionId, removed: false })
  assert.deepEqual(scoped.cleaned, [
    ['detach', sessionId],
    ['unarchive', sessionId]
  ])
}

// ── HTTP surface ────────────────────────────────────────────────────────────

function mockRequest(method, body) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload
    }
  }
}

function mockResponse() {
  return {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body += body
    }
  }
}

{
  const scoped = makeScoped()
  scoped.connection = { requestRejection: () => 401 }
  scoped.webServer = { register: () => () => {} }
  const handler = __test.makeHandler(scoped, { sessionsRoot: sessions, dshHome: home })
  const res = mockResponse()
  await handler(mockRequest('POST', { sessionId }), res)
  assert.equal(res.status, 401)
}

{
  const scoped = makeScoped()
  scoped.connection = { requestRejection: () => undefined }
  scoped.webServer = { register: () => () => {} }
  const handler = __test.makeHandler(scoped, { sessionsRoot: sessions, dshHome: home })
  const res = mockResponse()
  await handler(mockRequest('GET'), res)
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'POST')
}

{
  const scoped = makeScoped()
  scoped.connection = { requestRejection: () => undefined }
  scoped.webServer = { register: () => () => {} }
  const handler = __test.makeHandler(scoped, { sessionsRoot: sessions, dshHome: home })
  const res = mockResponse()
  await handler(mockRequest('POST', { sessionId }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, sessionId, removed: true })
}


// A Workspace failure after log removal remains retryable without archive
// membership, a live row, or even the original plugin module's memory.
{
  const options = { sessionsRoot: sessions, dshHome: home }
  const pendingDir = join(home, 'storages', 'session_actions', 'pending-deletes')
  const member = new Set([sessionId, 'other-session'])
  let fail = true
  const workspace = {
    // Filtered views may omit the stale membership after the log is gone.
    get sessionIds() { return [] },
    async detachSession(id) {
      assert.equal(id, sessionId)
      if (fail) throw new Error('injected Workspace cleanup failure')
      member.delete(id)
    }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'stub')
  const persisted = {
    async stat(id) {
      assert.equal(id, sessionId)
      try {
        await access(join(dir, 'session.v4.jsonl.zstd'))
        return { header: { id, cwd } }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return undefined
      }
    }
  }
  const services = () => makeScoped({
    registry: { archivedSessionIds: [], list: () => [workspace] },
    persistence: persisted
  })
  const scoped = services()
  scoped.logger = { warn() {} }
  const res1 = mockResponse()
  await __test.makeHandler(scoped, options)(mockRequest('POST', { sessionId }), res1)
  assert.equal(res1.status, 500)
  await assert.rejects(access(dir), { code: 'ENOENT' })
  assert.equal((await readdir(pendingDir)).length, 1)
  assert.ok(member.has(sessionId))

  fail = false
  const { __test: freshHost } = await import('../lib/index.js?fresh-host')
  const handler = freshHost.makeHandler(services(), options)
  const res2 = mockResponse()
  await handler(mockRequest('POST', { sessionId }), res2)
  assert.equal(res2.status, 200)
  assert.deepEqual(JSON.parse(res2.body), { ok: true, sessionId, removed: false })
  assert.deepEqual([...member], ['other-session'])
  assert.deepEqual(await readdir(pendingDir), [])

  const res3 = mockResponse()
  await handler(mockRequest('POST', { sessionId }), res3)
  assert.equal(res3.status, 404)
}

// An invalid or missing ID cannot be coerced into deleting a string-named session.
{
  const handler = __test.makeHandler(makeScoped(), { sessionsRoot: sessions, dshHome: home })
  for (const body of [null, {}, { sessionId: 42 }, { sessionId: '' }]) {
    const res = mockResponse()
    await handler(mockRequest('POST', body), res)
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).code, 'bad-request')
  }
}

await rm(home, { recursive: true, force: true })
console.log('host tests: ok')
