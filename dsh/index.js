// DeepSeek Harness (dsh) plugin — host half of the archive-session manager.
//
// The feature ("存档会话管理") exists in two forms in the wild:
//   * stock hosts (rc.5 unpatched, rc.6, ...): the backend is absent — the
//     persistence backend deletes outright, the workspace registry has no
//     archive/trash API, and the API proxy has no routes.
//   * hosts with the feature (rc.5 with the in-box patches, rc.7+ where the
//     upstream merged the feature): persistence has a native trash layer,
//     the registry has unarchiveSession/deleteSession/trash*, and the API
//     proxy has the routes.
// This host half makes the backend available on BOTH kinds of host:
//   1. `ensureTrashPersistence` — when the installed `sessionPersistence`
//      service has no trash support, `remove()` is overridden to MOVE the
//      session directory into `$DSH_HOME/trash` instead of deleting it, and
//      trashList/trashRestore/trashPurge/trashEmpty are added. Deletes stay
//      reversible.
//   2. `ensureRegistryApi` — when `unarchiveSession` / `deleteSession` /
//      `trashList` / `trashRestore` / `trashPurge` / `trashEmpty` are missing
//      from the `workspaceRegistry` service, they are added, replicating the
//      upstream implementation (live-session refusal, workspace accounting
//      detach, archive-set cleanup, restore re-attach). `deleteSession` is
//      FAIL-CLOSED: it refuses to run unless the persistence layer is
//      trash-aware, so a stock backend can never hard-delete a session.
//   3. Fallback HTTP API (`/dsh-archive/session`): the browser half calls
//      this when the client runtime lacks the native `ctx.workspaces`
//      methods. The route re-ensures the backend on demand, so a service
//      that is provided late (rc.7 registers the registry behind an inject
//      gate) is patched before the first request is served.
//
// Everything is feature-detected: on a host that already has the feature
// every step is a no-op. All failures degrade to logs — never take the host
// down. The plugin targets both the native Web UI (`dsh web` in a browser)
// and the desktop GUI (Electron window): they share the same host services
// and the same client bundle, so one implementation serves both.
//
// Zero dependency stance: node builtins only, exactly like the host half of
// the modlens plugin.
import { readdir, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const name = 'dsh-archive'
export const inject = []

// ---------------------------------------------------------------------------
// Module-private helpers replicated from dsh-session-persistence-jsonl so the
// trash layout is byte-for-byte compatible with the native implementation
// (`$DSH_HOME/trash/<encodedSessionId>-<movedAtMs>/`, headers parsed from the
// first log line). Keep these in lockstep with `patches/` and rc.7 upstream.
// ---------------------------------------------------------------------------

function isENOENT(error) {
  return error?.code === 'ENOENT'
}

function logSuffix(compression) {
  return compression === 'zstd' ? '.jsonl.zstd' : '.jsonl'
}

/** Encode an arbitrary string as one safe path segment (injective over UTF-16). */
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

/** Human-navigable project directory key (bounded, lossy on separators). */
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

function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd')
  return join(root, projectKey(cwd))
}

function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/** Type guard: a parsed first line is a well-formed session header. */
function isHeaderLine(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'session' &&
    typeof value.version === 'number' &&
    typeof value.id === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    !Object.is(value.createdAt, -0) &&
    typeof value.delegationDepth === 'number' &&
    Number.isSafeInteger(value.delegationDepth) &&
    value.delegationDepth >= 0 &&
    !Object.is(value.delegationDepth, -0) &&
    (value.origin === undefined || value.origin === 'subagent') &&
    (value.agentPreset === undefined || typeof value.agentPreset === 'string')
  )
}

/** Parse the first log line into session header meta (id/cwd/createdAt). */
function parseHeaderMeta(firstLine) {
  let parsed
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (!isHeaderLine(parsed)) return undefined
  return {
    version: parsed.version,
    id: parsed.id,
    createdAt: parsed.createdAt,
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    delegationDepth: parsed.delegationDepth,
  }
}

// ---------------------------------------------------------------------------
// 1. Session-persistence trash layer
// ---------------------------------------------------------------------------

/** Patch a JsonlSessionPersistence-like service with trash support (idempotent). */
function ensureTrashPersistence(persistence, log) {
  if (!persistence || typeof persistence !== 'object') return false
  if (typeof persistence.trashList === 'function') {
    log('[dsh-archive] persistence already has trash support — nothing to patch')
    return false
  }
  if (typeof persistence.findLog !== 'function' || typeof persistence.root !== 'string') {
    log(`[dsh-archive] persistence shape unrecognized (findLog=${typeof persistence.findLog}, root=${typeof persistence.root}) — skipping trash patch`)
    return false
  }
  const trashRoot = () => join(dirname(persistence.root), 'trash')
  const trashDirName = (id, movedAt) => `${encodeSegment(id)}-${movedAt}`
  const moveToTrash = async (dir) => {
    const root = trashRoot()
    await mkdir(root, { recursive: true })
    const target = join(root, trashDirName(basename(dir), Date.now()))
    await rename(dir, target)
  }
  const readFirstLine = async (path, signal) => {
    signal?.throwIfAborted()
    if (persistence.compression === 'zstd') return persistence.readFirstZstdLine(path, signal)
    return persistence.readFirstLine(path, signal)
  }
  const findTrashDir = async (id, signal) => {
    const prefix = `${encodeSegment(id)}-`
    let entries
    try {
      entries = await readdir(trashRoot(), { withFileTypes: true })
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
    signal?.throwIfAborted()
    const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    return match === undefined ? undefined : join(trashRoot(), match.name)
  }

  persistence.remove = async function removeToTrash(id, signal) {
    const path = await this.findLog(id, signal)
    if (path === undefined) return
    await moveToTrash(dirname(path))
  }
  persistence.trashRoot = trashRoot
  persistence.trashDirName = trashDirName
  persistence.moveToTrash = moveToTrash
  persistence.findTrashDir = findTrashDir
  persistence.trashList = async function trashList(signal) {
    const root = trashRoot()
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isENOENT(error)) return []
      throw error
    }
    const rows = []
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const path = join(dir, `session${logSuffix(this.compression)}`)
      let first
      try {
        first = await readFirstLine(path, signal)
      } catch {
        continue
      }
      if (first === undefined) continue
      const meta = parseHeaderMeta(first)
      if (meta === undefined) continue
      const dash = entry.name.lastIndexOf('-')
      const movedAt = Number(dash > 0 ? entry.name.slice(dash + 1) : NaN)
      rows.push({
        sessionId: meta.id,
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        movedAt: Number.isFinite(movedAt) && movedAt > 0 ? movedAt : (await stat(dir)).mtimeMs,
      })
    }
    return rows
  }
  persistence.trashRestore = async function trashRestore(id, signal) {
    const dir = await findTrashDir(id, signal)
    if (dir === undefined) return undefined
    const path = join(dir, `session${logSuffix(this.compression)}`)
    const first = await readFirstLine(path, signal)
    if (first === undefined) return undefined
    const meta = parseHeaderMeta(first)
    if (meta === undefined) return undefined
    const target = sessionDir(this.root, meta.cwd, meta.id)
    await mkdir(dirname(target), { recursive: true })
    await rename(dir, target)
    return meta
  }
  persistence.trashPurge = async function trashPurge(id, signal) {
    const dir = await findTrashDir(id, signal)
    if (dir === undefined) return
    await rm(dir, { recursive: true, force: true })
  }
  persistence.trashEmpty = async function trashEmpty(signal) {
    const root = trashRoot()
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!entry.isDirectory()) continue
      await rm(join(root, entry.name), { recursive: true, force: true })
    }
  }
  log('[dsh-archive] patched sessionPersistence: remove() now moves sessions to the trash (trashList/trashRestore/trashPurge/trashEmpty added)')
  return true
}

// ---------------------------------------------------------------------------
// 2. Workspace-registry archive/delete/trash API
// ---------------------------------------------------------------------------

function businessError(code, message, sessionId) {
  const error = new Error(message)
  error.code = code
  error.name = code === 'session-live' ? 'WorkspaceLiveSessionError' : 'WorkspaceUnknownSessionError'
  if (sessionId !== undefined) error.sessionId = sessionId
  return error
}

/**
 * Patch a WorkspaceRegistry-like service with the archive-manager API
 * (idempotent). Replicates the upstream implementation; `registry` exposes
 * the same instance members (enqueueOperation, requireState, setState,
 * sessionKnown, entities, headers, sessionPaths, invalidSessionPaths, ctx).
 *
 * `hooks.ensureTrash` (optional) re-runs the persistence trash patch; when it
 * is provided, `deleteSession` attempts it before refusing. `deleteSession`
 * is FAIL-CLOSED: if the persistence layer is not trash-aware after the
 * attempt, the delete is refused with `unavailable` and nothing is removed —
 * a stock (hard-delete) backend can never be driven by this plugin.
 */
function ensureRegistryApi(registry, log, hooks = {}) {
  if (!registry || typeof registry !== 'object') return false
  if (typeof registry.unarchiveSession === 'function') {
    log('[dsh-archive] workspaceRegistry already has the archive-manager API — nothing to patch')
    return false
  }
  if (typeof registry.enqueueOperation !== 'function' || typeof registry.sessionKnown !== 'function') {
    log(`[dsh-archive] workspaceRegistry shape unrecognized (enqueueOperation=${typeof registry.enqueueOperation}, sessionKnown=${typeof registry.sessionKnown}) — skipping API patch`)
    return false
  }
  const ensureTrash = () => {
    if (typeof hooks.ensureTrash !== 'function') return false
    try {
      hooks.ensureTrash()
    } catch (error) {
      /* logged by the caller of the hook */
    }
    const persistence = registry.ctx?.sessionPersistence
    return persistence !== undefined && typeof persistence.trashList === 'function'
  }

  registry.unarchiveSession = function unarchiveSession(sessionId) {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw businessError('session-not-found', `unknown session '${sessionId}'`, sessionId)
      }
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      })
    })
  }

  registry.deleteSession = function deleteSession(sessionId) {
    return this.enqueueOperation(async () => {
      // Fail-closed: never drive a hard-delete backend. Ensure the trash
      // layer first; refuse when it cannot be established.
      if (!ensureTrash()) {
        throw businessError(
          'unavailable',
          'trash backend unavailable — refusing to delete session (nothing was removed); the session-persistence service lacks trash support',
          sessionId,
        )
      }
      if (this.ctx?.get('sessions')?.get(sessionId) !== undefined) {
        throw businessError('session-live', `cannot delete session '${sessionId}': the session is live; stop or detach it before deleting`, sessionId)
      }
      if (!(await this.sessionKnown(sessionId))) {
        throw businessError('session-not-found', `unknown session '${sessionId}'`, sessionId)
      }
      await this.ctx.sessionPersistence.remove(sessionId)
      for (const entity of this.entities.values()) {
        if (entity.record.sessionIds.includes(sessionId)) await entity.detachSession(sessionId)
      }
      const state = this.requireState()
      if (state.archivedSessionIds.includes(sessionId)) {
        await this.setState({
          ...state,
          archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
        })
      }
      this.headers.delete(sessionId)
      this.sessionPaths.delete(sessionId)
      this.invalidSessionPaths.delete(sessionId)
      this.ctx?.emit?.('workspace/session-deleted', sessionId)
    })
  }

  registry.trashList = async function trashList() {
    return this.ctx.sessionPersistence.trashList()
  }

  registry.trashRestore = async function trashRestore(sessionId) {
    const header = await this.ctx.sessionPersistence.trashRestore(sessionId)
    if (header === undefined) {
      throw businessError('session-not-found', `no such trashed session '${sessionId}'`, sessionId)
    }
    this.headers.set(sessionId, header)
    this.sessionPaths.set(sessionId, header.cwd)
    this.invalidSessionPaths.delete(sessionId)
    this.ctx?.emit?.('workspace/session-restored', sessionId)
    return header
  }

  registry.trashPurge = async function trashPurge(sessionId) {
    return this.ctx.sessionPersistence.trashPurge(sessionId)
  }

  registry.trashEmpty = async function trashEmpty() {
    return this.ctx.sessionPersistence.trashEmpty()
  }

  log('[dsh-archive] patched workspaceRegistry: unarchiveSession / deleteSession / trashList / trashRestore / trashPurge / trashEmpty added (deleteSession is fail-closed on the trash layer)')
  return true
}

// ---------------------------------------------------------------------------
// 3. Fallback HTTP API for the browser half
// ---------------------------------------------------------------------------

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Register the fallback HTTP route. `scope` is the webServer inject scope
 * (has `.webServer`), `rootCtx` the plugin's apply ctx (service lookup +
 * on-demand backend ensure), `ensureBackend` the idempotent patch pass.
 */
function registerHttpApi(scope, rootCtx, ensureBackend, log) {
  if (!scope.webServer || typeof scope.webServer.register !== 'function') {
    log('[dsh-archive] webServer unavailable — skipping fallback HTTP API (headless profile?)')
    return
  }
  scope.webServer.register({
    name: 'dsh-archive-session',
    kind: 'exact',
    path: '/dsh-archive/session',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let payload
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        writeJson(res, 400, { ok: false, code: 'bad-request', message: 'expected a JSON body' })
        return
      }
      const op = payload?.op
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
      // On-demand backend ensure: services can be provided late (rc.7 gates
      // the registry behind an inject), so re-run the idempotent patch pass
      // before every request — it is a cheap no-op once applied.
      ensureBackend()
      const registry = rootCtx.get?.('workspaceRegistry') ?? rootCtx.workspaceRegistry
      if (!registry || typeof registry.trashList !== 'function') {
        writeJson(res, 503, { ok: false, code: 'unavailable', message: 'workspace registry backend is not available yet' })
        return
      }
      try {
        switch (op) {
          case 'unarchive': {
            if (!sessionId) throw businessError('bad-request', 'sessionId required')
            await registry.unarchiveSession(sessionId)
            writeJson(res, 200, { ok: true, value: { archivedSessionIds: [...registry.archivedSessionIds] } })
            return
          }
          case 'delete': {
            if (!sessionId) throw businessError('bad-request', 'sessionId required')
            await registry.deleteSession(sessionId)
            writeJson(res, 200, { ok: true, value: { deleted: true } })
            return
          }
          case 'trashList': {
            writeJson(res, 200, { ok: true, value: { items: await registry.trashList() } })
            return
          }
          case 'trashRestore': {
            if (!sessionId) throw businessError('bad-request', 'sessionId required')
            await registry.trashRestore(sessionId)
            writeJson(res, 200, { ok: true, value: { restored: true } })
            return
          }
          case 'trashPurge': {
            if (!sessionId) throw businessError('bad-request', 'sessionId required')
            await registry.trashPurge(sessionId)
            writeJson(res, 200, { ok: true, value: { purged: true } })
            return
          }
          case 'trashEmpty': {
            await registry.trashEmpty()
            writeJson(res, 200, { ok: true, value: { purged: true } })
            return
          }
          default:
            writeJson(res, 400, { ok: false, code: 'bad-request', message: `unknown op '${String(op)}'` })
        }
      } catch (error) {
        writeJson(res, 200, { ok: false, code: error?.code ?? 'internal', message: error?.message ?? String(error) })
      }
    },
  })
  log('[dsh-archive] registered fallback HTTP API at /dsh-archive/session')
}

// ---------------------------------------------------------------------------
// Cordis entry
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(message)
    } catch {
      // logging must never take the plugin down
    }
  }
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // ignore
    }
  }

  // One idempotent patch pass over both services. Safe to call repeatedly:
  // each ensure* feature-detects and no-ops once applied.
  const ensureBackend = () => {
    try {
      const persistence = ctx.get?.('sessionPersistence')
      if (persistence) ensureTrashPersistence(persistence, log)
    } catch (error) {
      warn(`[dsh-archive] session-persistence trash patch failed: ${String(error)}`)
    }
    try {
      const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
      if (registry) {
        ensureRegistryApi(registry, log, { ensureTrash: ensureBackend })
      }
    } catch (error) {
      warn(`[dsh-archive] workspace-registry API patch failed: ${String(error)}`)
    }
  }

  // Patch now if the services are already present...
  ensureBackend()
  // ...and again whenever they appear later (rc.7+ registers the registry
  // behind an inject gate, so it may arrive after this plugin's apply).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionPersistence'], () => ensureBackend())
    ctx.inject(['workspaceRegistry'], () => ensureBackend())
  }

  // The fallback HTTP API rides a scoped inject (webServer is optional and
  // absent under headless), mirroring the modlens plugin.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerHttpApi(scope, ctx, ensureBackend, log)
      } catch (error) {
        warn(`[dsh-archive] fallback HTTP API skipped: ${String(error)}`)
      }
    })
  }
}
