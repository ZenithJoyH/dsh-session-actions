// dsh-session-actions — Host half.
//
// DSH deliberately has no Session-delete primitive: a Session can be archived
// but never removed, and the shipped workspace README says so explicitly.
// This plugin adds one guarded destructive operation on top of that:
// permanently delete any Session that is *not running*.
//
// A Session does not need to be archived first. The confirmation dialog is the
// deliberate second gesture; the Host refuses only a live running turn (and an
// unknown id), and cleans the archived set when the id happens to be archived.
//
// The Host owns the filesystem operation and exposes one authenticated HTTP
// route for the browser half. The route lives outside /api so it cannot be
// confused with a generated Typert Remote endpoint.

import { createHash } from 'node:crypto'
import { lstat, mkdir, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'dsh-session-actions'

const DEFAULT_ROUTE = '/plugin/session-actions/delete'
const MAX_BODY_BYTES = 64 * 1024

/** One in-flight deletion per storage root and Session, before any side effects. */
const inFlight = new Set()

// ── path encoding (mirrors @deepseek-ai/dsh-session-persistence-jsonl) ──────
// The backend's session directory name is a stable, documented projection of
// the header cwd + Session id. We reproduce it instead of importing the
// package: a plugin installed into a profile cannot resolve @deepseek-ai/*
// bare imports, and the encoding is part of the on-disk format.

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function dshHome(options) {
  return resolve(options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
}

function sessionsRoot(options) {
  return resolve(options.sessionsRoot || join(dshHome(options), 'sessions'))
}

function sessionDirectory(root, header, sessionId) {
  const key = header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd)
  const dir = join(root, key, encodeSegment(String(sessionId)))
  const fence = root.endsWith(sep) ? root : root + sep
  if (!isAbsolute(dir) || !dir.startsWith(fence)) {
    throw new Error('refusing a session path outside the configured sessions root')
  }
  return dir
}

// ── errors ──────────────────────────────────────────────────────────────────

class DeleteError extends Error {
  constructor(code, status, message) {
    super(message)
    this.name = 'ArchiveDeleteError'
    this.code = code
    this.status = status
  }
}

// ── core operation ──────────────────────────────────────────────────────────

function pendingDeleteDirectory(options, root, id) {
  const key = createHash('sha256').update(JSON.stringify([root, id])).digest('hex')
  return join(dshHome(options), 'storages', 'session_actions', 'pending-deletes', key)
}

async function hasPendingDelete(marker) {
  let info
  try {
    info = await lstat(marker)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!info.isDirectory()) throw new Error('invalid pending session deletion marker')
  return true
}

async function markPendingDelete(marker) {
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
  try {
    await mkdir(marker, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await hasPendingDelete(marker))) throw error
  }
}

async function clearPendingDelete(marker) {
  try {
    await rmdir(marker)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function checkWriteOwnership(persistence, id) {
  let handle
  try {
    handle = await persistence.open(id, 'write')
  } catch (error) {
    if (error?.name === 'SessionPersistenceNotFoundError') return
    if (error?.name === 'SessionAlreadyOwnedError') {
      throw new DeleteError('locked', 423, 'the session is owned by another writer')
    }
    throw error
  }
  await handle.close()
}

async function quiesceIdleAgent(agent) {
  // The official loop does not expose an unload-by-id handle to this plugin.
  // Preserve the existing best-effort cancellation/disposal for resident agents.
  try {
    agent.cancel?.({ kind: 'disposed' }, { keepInbox: true })
  } catch {}
  const scope = typeof agent.scope?.dispose === 'function' ? agent.scope : agent.ctx?.fiber
  try {
    await scope?.dispose?.()
  } catch {}
}

/**
 * Delete a non-running Session. An on-disk marker written before deletion
 * allows a retry even if the log and live entry are already gone.
 * Only an explicit retry for the same id resumes pending cleanup.
 */
export async function deleteSession(scoped, sessionId, options) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')) {
    throw new DeleteError('bad-request', 400, 'sessionId must be a non-empty string')
  }
  const id = sessionId
  const root = sessionsRoot(options)
  const key = JSON.stringify([root, id])
  if (inFlight.has(key)) throw new DeleteError('busy', 409, 'another delete is already in progress')
  inFlight.add(key)
  try {
    const registry = scoped.workspaceRegistry
    if (registry === undefined) throw new DeleteError('unavailable', 503, 'Workspace registry is unavailable')

    const liveAgent = scoped.get('agents')?.get(id)
    if (liveAgent !== undefined && liveAgent.status !== 'idle') {
      throw new DeleteError('active', 409, 'the session is currently running')
    }

    const store = scoped.get('sessions')?.store
    const liveEntry = store?.get?.(id)
    const persistence = scoped.get('sessionPersistence')
    const marker = pendingDeleteDirectory(options, root, id)
    const pending = await hasPendingDelete(marker)
    if (pending && persistence === undefined) {
      throw new DeleteError('unavailable', 503, 'Session persistence is unavailable')
    }
    const snapshot = await persistence?.stat(id)
    const wasArchived = registry.archivedSessionIds.includes(id)
    if (!pending && snapshot === undefined && liveEntry === undefined && liveAgent === undefined && !wasArchived) {
      throw new DeleteError('not-found', 404, 'no such session')
    }

    const dir = snapshot === undefined ? undefined : sessionDirectory(root, snapshot.header, id)
    // Check the persistence lock before detaching a cold session. An idle
    // resident Agent can itself own the write handle, so keep its existing
    // quiesce path instead of treating that handle as an external writer.
    if (liveAgent === undefined && snapshot !== undefined) await checkWriteOwnership(persistence, id)
    await markPendingDelete(marker)

    // Look up again after the asynchronous admission steps: do not cancel or
    // detach an Agent that started running while we were checking the store.
    const currentAgent = scoped.get('agents')?.get(id)
    if (currentAgent !== liveAgent || (currentAgent !== undefined && currentAgent.status !== 'idle')) {
      throw new DeleteError('active', 409, 'the session is currently running or changing state')
    }
    if (currentAgent !== undefined) await quiesceIdleAgent(currentAgent)
    const agentAfterQuiesce = scoped.get('agents')?.get(id)
    const entryBeforeRemoval = store?.get?.(id)
    if (
      (agentAfterQuiesce !== undefined &&
        (agentAfterQuiesce !== currentAgent || agentAfterQuiesce.status !== 'idle')) ||
      (entryBeforeRemoval !== undefined && entryBeforeRemoval !== liveEntry)
    ) {
      throw new DeleteError('active', 409, 'the session is currently running or changing state')
    }

    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    // The list merges persisted and live entries. Detach only after admission
    // and log removal so a rejected or failed deletion does not hide the row.
    const entry = store?.get?.(id)
    if (entry === liveEntry) await entry?.detach?.()

    // Projection cleanup is best-effort. Only use a literal, single filename.
    if (!/[\\/:]/.test(id)) {
      await rm(join(dshHome(options), 'storages', 'session_projcache', 'sessions', `${id}.json`), {
        force: true
      }).catch(() => {})
    }

    // The filtered workspace view can hide stale raw membership, so visit
    // every workspace. Keep the marker until both registry steps succeed.
    for (const workspace of registry.list()) {
      if (typeof workspace.detachSession === 'function') await workspace.detachSession(id)
    }
    await registry.unarchiveSession(id)
    await clearPendingDelete(marker)

    return { sessionId: id, removed: dir !== undefined }
  } finally {
    inFlight.delete(key)
  }
}

// ── HTTP surface ────────────────────────────────────────────────────────────

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new DeleteError('payload-too-large', 413, 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new DeleteError('bad-request', 400, 'request body must be JSON')
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function rejectionMessage(status) {
  return status === 403 ? 'forbidden' : 'unauthorized'
}

function makeHandler(scoped, options) {
  return async function handleArchiveDelete(req, res) {
    try {
      // Host/Origin fence + browser-session authentication, shared with every
      // other Host API. Without the browser cookie this route is closed.
      const connection = scoped.connection
      const rejection = connection === undefined ? undefined : connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejectionMessage(rejection))
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }

      const body = await readJsonBody(req)
      const result = await deleteSession(scoped, body?.sessionId, options)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      if (error instanceof DeleteError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      const logger = scoped.logger
      if (logger !== undefined && typeof logger.warn === 'function') logger.warn(`[dsh-session-actions] ${String(error)}`)
      else console.error('[dsh-session-actions]', error)
      sendJson(res, 500, {
        ok: false,
        code: 'internal',
        message: 'failed to delete the session'
      })
    }
  }
}

/**
 * Mount the Host half: one exact route, owned by this plugin's fiber.
 *
 * @param {object} ctx Cordis context.
 * @param {object} [config] Plugin options.
 * @param {string} [config.route] Route path, default `/plugin/session-actions/delete`.
 * @param {string} [config.sessionsRoot] Override the JSONL persistence root.
 * @param {string} [config.dshHome] Override the DSH home used for the cache path.
 */
export function apply(ctx, config = {}) {
  const options = {
    route: typeof config.route === 'string' && config.route.startsWith('/') ? config.route : DEFAULT_ROUTE,
    sessionsRoot: typeof config.sessionsRoot === 'string' ? config.sessionsRoot : undefined,
    dshHome: typeof config.dshHome === 'string' ? config.dshHome : undefined
  }

  ctx.inject(['webServer', 'connection', 'workspaceRegistry'], (scoped) => {
    const handler = makeHandler(scoped, options)
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: options.route,
          handler
        }),
      `dsh-session-actions: ${options.route}`
    )
  })
}

export const __test = {
  DeleteError,
  deleteSession,
  encodeSegment,
  makeHandler,
  projectKey,
  sessionDirectory,
  sessionsRoot
}
