// Robustness tests for the dsh-archive HOST half against the failure modes
// found in the rc.7 audit:
//   1. late service provision — workspaceRegistry arrives after apply()
//      (rc.7 gates it behind `static inject`); the ctx.inject callbacks must
//      patch it when it appears.
//   2. fail-closed deleteSession — when persistence has no trash layer (and
//      cannot be patched), deleteSession refuses with `unavailable` and
//      nothing is removed (no hard delete).
//   3. fallback HTTP route on-demand ensure — a request served before the
//      registry exists returns 503 `unavailable`; after the service appears
//      and the route re-ensures, the same handler serves 200.
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { apply } from '../dsh/index.js'

const failures = []
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function makePersistence(root, { withTrash = false } = {}) {
  const service = {
    root,
    compression: 'none',
    // current hosts answer with a generation record, not a bare path
    findLog: async (id) => {
      const p = join(root, '--C-work-demo--', id, 'session.v3.jsonl')
      try {
        await readFile(p)
      } catch {
        return undefined
      }
      return { sourcePath: p, sourceVersion: 3, currentPath: p }
    },
    readFirstLine: async (p) => (await readFile(p, 'utf8')).split('\n')[0],
    remove: async (id) => {
      // stock (hard) remove — must never be reached by the plugin
      await rm(join(root, '--C-work-demo--', id), { recursive: true, force: true })
    },
  }
  if (withTrash) {
    // native rc.7-style trash layer (upstream merged the feature)
    service.trashRoot = () => join(dirname(root), 'trash')
    service.moveToTrash = async (dir) => {
      await mkdir(service.trashRoot(), { recursive: true })
      await rename(dir, join(service.trashRoot(), `${basename(dir)}-${Date.now()}`))
    }
    service.remove = async (id) => {
      const selected = await service.findLog(id)
      if (selected !== undefined) await service.moveToTrash(dirname(selected.sourcePath))
    }
    service.trashList = async () => {
      try {
        return (await readdir(service.trashRoot())).map((name) => ({ sessionId: name.split('-')[0] }))
      } catch {
        return []
      }
    }
  }
  return service
}

function makeRegistry(persistence, { live = false, nativeArchiveApi = false } = {}) {
  const archived = []
  const registry = {
    archivedSessionIds: archived,
    headers: new Map(),
    entities: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Set(),
    ctx: {
      sessionPersistence: persistence,
      get(name) {
        if (name === 'sessions') return { get: () => (live ? { } : undefined) }
        if (name === 'sessionPersistence') return persistence
        if (name === 'workspaceRegistry') return this
        return undefined
      },
      emit: () => {},
    },
    enqueueOperation: (fn) => fn(),
    requireState: () => ({ archivedSessionIds: archived }),
    setState: async (next) => {
      archived.length = 0
      next.archivedSessionIds.forEach((id) => archived.push(id))
    },
    sessionKnown: async (id) => (await persistence.findLog(id)) !== undefined,
    archiveSession: (id) => {
      archived.push(id)
      return Promise.resolve()
    },
  }
  if (nativeArchiveApi) {
    // hosts that ship PART of the archive API (0.1.7-rc.1: unarchiveSession and
    // archiveSession exist upstream, deleteSession and the trash layer do not)
    registry.unarchiveSession = function unarchiveSession(sessionId) {
      return this.enqueueOperation(async () => {
        if (!archived.includes(sessionId)) return
        await this.setState({ archivedSessionIds: archived.filter((id) => id !== sessionId) })
      })
    }
  }
  return registry
}

// ---------------------------------------------------------------------------
// Scenario 1: late service provision (rc.7 inject-gated registry)
// ---------------------------------------------------------------------------
console.log('--- late service provision ---')
{
  const root = join(await mkdtemp(join(tmpdir(), 'dsh-late-')), 'sessions')
  await mkdir(root, { recursive: true })
  const persistence = makePersistence(root)
  let registry
  const injectCallbacks = {}
  const logs = []
  const services = {}
  apply({
    get: (n) => services[n],
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    inject(servicesList, cb) {
      injectCallbacks[servicesList[0]] = cb
    },
  })
  check('apply ran with no services present', Object.keys(injectCallbacks).length >= 2)
  check('no patch logged at apply (services absent)', logs.every((l) => !l.includes('patched')))

  // persistence appears first, then the registry (rc.7 style)
  services.sessionPersistence = persistence
  injectCallbacks.sessionPersistence?.()
  check('persistence patched when it appeared', typeof persistence.trashList === 'function')

  registry = makeRegistry(persistence)
  services.workspaceRegistry = registry
  injectCallbacks.workspaceRegistry?.()
  check('registry patched when it appeared', typeof registry.unarchiveSession === 'function')
  check('registry trashList available', typeof registry.trashList === 'function')

  await rm(dirname(root), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Scenario 2: fail-closed deleteSession without a trash layer
// ---------------------------------------------------------------------------
console.log('--- fail-closed delete ---')
{
  const root = join(await mkdtemp(join(tmpdir(), 'dsh-failclosed-')), 'sessions')
  await mkdir(root, { recursive: true })
  const persistence = makePersistence(root, { withTrash: false })
  const registry = makeRegistry(persistence)
  const sid = 'sid-fc-1'
  await mkdir(join(root, '--C-work-demo--', sid), { recursive: true })
  await writeFile(join(root, '--C-work-demo--', sid, 'session.v3.jsonl'), `{"type":"session","version":3,"id":"${sid}","createdAt":1750000000000,"cwd":"C:\\\\work\\\\demo","delegationDepth":0,"isSeeded":false}\n`)
  await registry.archiveSession(sid)
  // persistence that can never be trash-aware: remove its findLog (shape guard fails)
  persistence.findLog = undefined
  apply({
    get: (n) => (n === 'sessionPersistence' ? persistence : n === 'workspaceRegistry' ? registry : undefined),
    logger: { info: () => {}, warn: () => {} },
  })
  let error = null
  try {
    await registry.deleteSession(sid)
  } catch (e) {
    error = e
  }
  check('deleteSession refused with unavailable', error !== null && error.code === 'unavailable')
  const stillThere = await readFile(join(root, '--C-work-demo--', sid, 'session.v3.jsonl')).then(() => true).catch(() => false)
  check('session artifact untouched (no hard delete)', stillThere)
  await rm(dirname(root), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Scenario 3: fallback route — 503 before registry, 200 after on-demand ensure
// ---------------------------------------------------------------------------
console.log('--- fallback route on-demand ensure ---')
{
  const root = join(await mkdtemp(join(tmpdir(), 'dsh-route-')), 'sessions')
  await mkdir(root, { recursive: true })
  const persistence = makePersistence(root, { withTrash: true }) // native rc.7-style persistence
  let registry = undefined
  let handler = null
  const routed = { webServer: { register: (entry) => { handler = entry.handler } } }
  apply({
    get: (n) => (n === 'sessionPersistence' ? persistence : n === 'workspaceRegistry' ? registry : undefined),
    logger: { info: () => {}, warn: () => {} },
    inject(services, cb) {
      if (services[0] === 'webServer') cb(routed)
      if (services[0] === 'sessionPersistence') cb()
      if (services[0] === 'workspaceRegistry') cb()
    },
  })
  check('route registered', typeof handler === 'function')

  const post = (body) => {
    const req = {
      method: 'POST',
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(JSON.stringify(body))]
        let i = 0
        return {
          next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
        }
      },
    }
    let status = 0
    let text = ''
    const res = {
      writeHead(s) { status = s },
      end(b) { text = b },
    }
    return handler(req, res).then(() => ({ status, body: JSON.parse(text) }))
  }

  const early = await post({ op: 'trashList' })
  check('request before registry ready → 503 unavailable', early.status === 503 && early.body.code === 'unavailable')

  registry = makeRegistry(persistence) // registry arrives later, unpatched
  const late = await post({ op: 'trashList' })
  check('request after registry appears → 200 with items', late.status === 200 && late.body.ok === true && Array.isArray(late.body.value.items))
  check('registry patched on demand by the route', typeof registry.trashList === 'function' && typeof registry.unarchiveSession === 'function')

  const bad = await post({ op: 'nonsense' })
  check('unknown op → 400 bad-request', bad.status === 400 && bad.body.code === 'bad-request')
  await rm(dirname(root), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Scenario 4: the host ships HALF the archive API (0.1.7-rc.1 regression)
// ---------------------------------------------------------------------------
// 0.1.7-rc.1 provides archiveSession/unarchiveSession upstream but no
// deleteSession and no trash layer. A blanket "unarchiveSession exists, so the
// whole API exists" guard skipped the patch, the route then found no
// `trashList`, and every delete answered
// `workspace registry backend is not available yet`.
console.log('--- partial native archive API ---')
{
  const root = join(await mkdtemp(join(tmpdir(), 'dsh-partial-')), 'sessions')
  await mkdir(root, { recursive: true })
  const persistence = makePersistence(root)
  const registry = makeRegistry(persistence, { nativeArchiveApi: true })
  const nativeUnarchive = registry.unarchiveSession

  let handler = null
  apply({
    get: (n) => (n === 'sessionPersistence' ? persistence : n === 'workspaceRegistry' ? registry : undefined),
    logger: { info: () => {}, warn: () => {} },
    inject(services, cb) {
      if (services[0] === 'webServer') cb({ webServer: { register: (entry) => { handler = entry.handler } } })
      else cb()
    },
  })

  check('native unarchiveSession is left untouched', registry.unarchiveSession === nativeUnarchive)
  check('missing deleteSession added', typeof registry.deleteSession === 'function')
  check('missing trash API added', typeof registry.trashList === 'function' && typeof registry.trashRestore === 'function' && typeof registry.trashPurge === 'function' && typeof registry.trashEmpty === 'function')

  const post = (body) => {
    const req = {
      method: 'POST',
      [Symbol.asyncIterator]() {
        const chunks = [Buffer.from(JSON.stringify(body))]
        let i = 0
        return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }
      },
    }
    let status = 0
    let text = ''
    const res = {
      writeHead(s) { status = s },
      end(b) { text = b },
    }
    return handler(req, res).then(() => ({ status, body: JSON.parse(text) }))
  }

  const list = await post({ op: 'trashList' })
  check('trashList on a partial host → 200 (not 503)', list.status === 200 && list.body.ok === true, JSON.stringify(list.body))

  const sid = 'partial-sid-1'
  // projectKey('C:\work\demo') collapses the separator run to `--C-work-demo--`
  await mkdir(join(root, '--C-work-demo--', sid), { recursive: true })
  await writeFile(join(root, '--C-work-demo--', sid, 'session.v3.jsonl'), `{"type":"session","version":3,"id":"${sid}","createdAt":1750000000000,"cwd":"C:\\\\work\\\\demo","delegationDepth":0,"isSeeded":false}\n`)
  await registry.archiveSession(sid)
  const deleted = await post({ op: 'delete', sessionId: sid })
  check('delete on a partial host → moved to trash', deleted.body.ok === true && deleted.body.value.deleted === true, JSON.stringify(deleted.body))
  const rows = await persistence.trashList()
  check('the deleted session is listed in the trash', rows.some((row) => row.sessionId === sid), JSON.stringify(rows))
  const restored = await post({ op: 'trashRestore', sessionId: sid })
  check('restore on a partial host → back in the live store', restored.body.ok === true && (await persistence.findLog(sid)) !== undefined, JSON.stringify(restored.body))
  await rm(dirname(root), { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nALL HOST ROBUSTNESS CHECKS PASSED')
