// Regression test: the HOST half must work under Cordis 4's strict inject
// enforcement (regression for 0.2.1 — "cannot get property "sessionPersistence"
// without inject" when moving an archived session to the trash).
//
// Why a dedicated test: the earlier host-logic-test.mjs drives the patched
// methods through a plain mock ctx whose `sessionPersistence` is a literal
// property, so it never exercised real Cordis semantics. Under Cordis 4:
//   * services provided by Service-class plugins live in their OWN fiber
//     stores — a bare `ctx.sessionPersistence` read from a fiber whose inject
//     does not cover the service throws "cannot get property ... without inject";
//   * every service value read off a context is wrapped in a "traceable"
//     proxy whose `ctx` property returns the CALLER's context — so reading
//     `registry.ctx?.sessionPersistence` from the plugin's own ctx resolves
//     to the plugin ctx (inject: []) and throws, while `this.ctx` inside the
//     patched methods carries the shadowed registry ctx and works.
// This test boots a real Cordis Context with Service-class fakes and drives
// the plugin's registered /dsh-archive/session route (the exact path the
// browser half uses when the native client API is absent).
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../dsh/index.js'

const failures = []
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// --- fakes ------------------------------------------------------------------

// Fake session persistence as a Service CLASS (like the real
// dsh-session-persistence-jsonl): the service lands in this fiber's store,
// NOT the root fiber's store — the exact condition that makes Cordis 4's
// strict check bite.
class FakePersistence extends Service {
  constructor(ctx, config) {
    super(ctx, 'sessionPersistence')
    this.root = config.root
    this.compression = 'none'
  }
  async findLog(id) {
    // current hosts answer with a generation record, not a bare path
    const path = join(this.root, '--C-work-demo--', id, 'session.v3.jsonl')
    try {
      await readFile(path)
    } catch {
      return undefined
    }
    return { sourcePath: path, sourceVersion: 3, currentPath: path }
  }
  async readFirstLine(path) {
    const text = await readFile(path, 'utf8')
    return text.split('\n')[0]
  }
  async list() {
    return []
  }
  // stock shape: no trash support; remove hard-deletes
  async remove(id) {
    await rm(join(this.root, '--C-work-demo--', id), { recursive: true, force: true })
  }
}

// Fake workspace registry as a Service CLASS, mirroring the real
// WorkspaceRegistry: same static inject (sessionPersistence), same shape the
// plugin patches (enqueueOperation/sessionKnown/requireState/setState +
// entities/headers/sessionPaths/invalidSessionPaths + archivedSessionIds).
class FakeRegistry extends Service {
  static inject = ['sessionPersistence']
  constructor(ctx) {
    super(ctx, 'workspaceRegistry')
    this.entities = new Map()
    this.headers = new Map()
    this.sessionPaths = new Map()
    this.invalidSessionPaths = new Map()
    this.operationTail = Promise.resolve()
    this.state = { initialized: true, archivedSessionIds: [], workspaceOrder: [], workspaces: [] }
  }
  requireState() { return this.state }
  async setState(next) { this.state = next; return next }
  enqueueOperation(fn) {
    const run = this.operationTail.then(async () => await fn())
    this.operationTail = run.then(() => undefined, () => undefined)
    return run
  }
  async sessionKnown(id) { return this.headers.has(id) || this.sessionPaths.has(id) }
  get archivedSessionIds() { return this.state.archivedSessionIds }
}

// --- boot -------------------------------------------------------------------

const base = await mkdtemp(join(tmpdir(), 'dsh-archive-c4-'))
const root = join(base, 'sessions')
await mkdir(root, { recursive: true })

const app = new Context()
const sessionsStub = { get: () => undefined, list: () => [] }
app.provide('sessions', sessionsStub)

let pluginCtx = null
const plugin = {
  name: 'dsh-archive',
  inject: [],
  apply(ctx, config) {
    pluginCtx = ctx
    return apply(ctx, config)
  },
}

try {
  await app.plugin(FakePersistence, { root })
  await app.plugin(FakeRegistry)
  const routes = []
  app.provide('webServer', { register(r) { routes.push(r) } })
  await app.plugin(plugin)
  await new Promise((resolve) => setTimeout(resolve, 50)) // let inject fibers settle

  const registry = app.get('workspaceRegistry')
  const route = routes.find((r) => r.path === '/dsh-archive/session')
  check('route registered', !!route)

  // seed one archived session
  const sid = 'test-session-0001'
  const located = join(root, '--C-work-demo--', sid, 'session.v3.jsonl')
  await mkdir(dirname(located), { recursive: true })
  await writeFile(located, `{"type":"session","version":3,"id":"${sid}","createdAt":1750000000000,"cwd":"C:\\\\work\\\\demo","delegationDepth":0,"isSeeded":false}\n`)
  registry.headers.set(sid, { id: sid, cwd: 'C:\\work\\demo' })
  registry.sessionPaths.set(sid, 'C:\\work\\demo')
  registry.state.archivedSessionIds.push(sid)

  const makeReq = (body) => ({
    method: 'POST',
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) },
  })
  const call = async (op, sessionId) => {
    const res = { status: 0, body: '' }
    res.writeHead = (s) => { res.status = s }
    res.end = (b) => { res.body = b }
    await route.handler(makeReq({ op, sessionId }), res)
    return JSON.parse(res.body)
  }

  // the regression: delete must NOT reject with the Cordis 4 strict-inject error
  let result = await call('delete', sid)
  check('delete archived session -> moved to trash', result.ok === true && result.value.deleted === true, JSON.stringify(result))

  const trashRoot = join(base, 'trash')
  const trashDirs = await readdir(trashRoot)
  check('session dir physically in trash', trashDirs.length === 1 && trashDirs[0].startsWith(`${sid}-`))

  result = await call('trashList')
  check('trashList lists the trashed session', result.ok === true && result.value.items.some((i) => i.sessionId === sid), JSON.stringify(result))

  result = await call('trashRestore', sid)
  check('trashRestore ok', result.ok === true && result.value.restored === true, JSON.stringify(result))
  try {
    await stat(located)
    check('session artifact back in live store', true)
  } catch {
    check('session artifact back in live store', false)
  }

  // live-session refusal still fail-closed through the route
  sessionsStub.get = (id) => (id === sid ? {} : undefined)
  await mkdir(dirname(located), { recursive: true })
  await writeFile(located, `{"type":"session","version":1,"id":"${sid}","createdAt":1750000000000,"cwd":"C:\\\\work\\\\demo","delegationDepth":0}\n`)
  result = await call('delete', sid)
  check('delete live session -> session-live refusal', result.ok === false && result.code === 'session-live', JSON.stringify(result))
  sessionsStub.get = () => undefined
} finally {
  await rm(base, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nALL CORDIS 4 STRICT-INJECT CHECKS PASSED')
