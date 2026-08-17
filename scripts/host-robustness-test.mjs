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
    findLog: async (id) => {
      const p = join(root, '--C-work--demo--', id, 'session.jsonl')
      try {
        await readFile(p)
        return p
      } catch {
        return undefined
      }
    },
    readFirstLine: async (p) => (await readFile(p, 'utf8')).split('\n')[0],
    remove: async (id) => {
      // stock (hard) remove — must never be reached by the plugin
      await rm(join(root, '--C-work--demo--', id), { recursive: true, force: true })
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
      const p = await service.findLog(id)
      if (p !== undefined) await service.moveToTrash(dirname(p))
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

function makeRegistry(persistence, { live = false } = {}) {
  const archived = []
  return {
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
  await mkdir(join(root, '--C-work--demo--', sid), { recursive: true })
  await writeFile(join(root, '--C-work--demo--', sid, 'session.jsonl'), `{"type":"session","version":1,"id":"${sid}","createdAt":1750000000000,"cwd":"C:\\\\work\\\\demo","delegationDepth":0}\n`)
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
  const stillThere = await readFile(join(root, '--C-work--demo--', sid, 'session.jsonl')).then(() => true).catch(() => false)
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

if (failures.length > 0) {
  console.error(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nALL HOST ROBUSTNESS CHECKS PASSED')
