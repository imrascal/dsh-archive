// Logic test for the dsh-archive HOST half: exercises ensureTrashPersistence
// and ensureRegistryApi against mock services that mirror the stock (patch-
// free) shapes, then verifies the full trash lifecycle end to end on a
// temporary directory. Mirrors the in-box verification methodology
// (isolated temp root + real-shaped services).
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
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

// --- mock persistence ------------------------------------------------------
// Mirrors the REAL current backend shape: `findLog` returns a generation
// record (`{sourcePath, sourceVersion, currentPath}`), NOT a bare path, and a
// session directory names its log after the format generation
// (`session.v3.jsonl`). The earlier mock returned a plain `session.jsonl`
// path string, which is exactly why the "path argument must be of type
// string" crash shipped — keep both shapes covered below.
const LOG_NAME = 'session.v3.jsonl'

function makePersistence(root, { findLogShape = 'record', logName = LOG_NAME } = {}) {
  const logPath = (id) => join(root, '--C-work-demo--', id, logName)
  const service = {
    root,
    compression: 'none',
    findLog: async (id) => {
      const path = logPath(id)
      try {
        await readFile(path)
      } catch {
        return undefined
      }
      if (findLogShape === 'string') return path
      return { sourcePath: path, sourceVersion: 3, currentPath: path }
    },
    readFirstLine: async (path) => {
      const text = await readFile(path, 'utf8')
      return text.split('\n')[0]
    },
    // stock remove: hard delete (no trash)
    remove: async (id) => {
      await rm(join(root, '--C-work-demo--', id), { recursive: true, force: true })
    },
    // stock has readFirstZstdLine only for zstd; 'none' uses readFirstLine
  }
  return service
}

// --- mock registry (stock shape: archiveSession only, no unarchive/delete/trash)
function makeRegistry(persistence) {
  const archived = []
  const headers = new Map()
  const entities = new Map()
  const events = []
  const state = { archivedSessionIds: archived }
  return {
    archivedSessionIds: archived,
    headers,
    entities,
    sessionPaths: new Map(),
    invalidSessionPaths: new Set(),
    ctx: {
      // provided services surface as ctx properties in the real host
      sessionPersistence: persistence,
      get(name) {
        if (name === 'sessions') return { get: () => undefined } // nothing live
        if (name === 'sessionPersistence') return persistence
        if (name === 'workspaceRegistry') return this
        return undefined
      },
      emit(name, value) {
        events.push([name, value])
      },
    },
    enqueueOperation(fn) {
      return fn()
    },
    requireState() {
      return state
    },
    setState(next) {
      state.archivedSessionIds = next.archivedSessionIds
      archived.length = 0
      for (const id of next.archivedSessionIds) archived.push(id)
      return Promise.resolve()
    },
    async sessionKnown(id) {
      return (await persistence.findLog(id)) !== undefined
    },
    archiveSession(id) {
      archived.push(id)
      return Promise.resolve()
    },
  }
}

// --- scenario ---------------------------------------------------------------
// Isolated sandbox: `base/sessions` is the persistence root, so the plugin's
// trash lands in the unique sibling `base/trash` (mirrors the real layout
// where trash sits next to the sessions root).
const base = await mkdtemp(join(tmpdir(), 'dsh-archive-test-'))
const root = join(base, 'sessions')
await mkdir(root, { recursive: true })
const headerLine = (id, cwd) => `{"type":"session","version":3,"id":"${id}","createdAt":1750000000000,"cwd":"${cwd}","delegationDepth":0,"isSeeded":false}\n`
const seed = async (dir_root, id, name, cwd = 'C:\\\\work\\\\demo') => {
  const dir = join(dir_root, '--C-work-demo--', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), headerLine(id, cwd))
  return dir
}
try {
  const persistence = makePersistence(root)
  const registry = makeRegistry(persistence)

  // seed one session, then archive it
  const sid = 'test-session-0001'
  await seed(root, sid, LOG_NAME)
  await registry.archiveSession(sid)
  check('seed: session archived', registry.archivedSessionIds.includes(sid))

  // apply the plugin with a stub ctx that routes to our services
  const logs = []
  const stubCtx = {
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  }
  apply(stubCtx)

  check('patch: persistence got trashList', typeof persistence.trashList === 'function')
  check('patch: persistence.remove now moves to trash', /moveToTrash|trash/.test(persistence.remove.toString()))
  check('patch: registry got unarchiveSession', typeof registry.unarchiveSession === 'function')
  check('patch: registry got deleteSession', typeof registry.deleteSession === 'function')
  check('patch: registry got trashList', typeof registry.trashList === 'function')
  check('patch: registry got trashRestore', typeof registry.trashRestore === 'function')
  check('patch: registry got trashPurge', typeof registry.trashPurge === 'function')
  check('patch: registry got trashEmpty', typeof registry.trashEmpty === 'function')

  // idempotency: applying again must not re-patch
  const removeRef = persistence.remove
  const unarchiveRef = registry.unarchiveSession
  apply(stubCtx)
  check('patch: second apply is a no-op (persistence)', persistence.remove === removeRef)
  check('patch: second apply is a no-op (registry)', registry.unarchiveSession === unarchiveRef)

  // delete → trash
  await registry.deleteSession(sid)
  check('delete: session removed from archive set', !registry.archivedSessionIds.includes(sid))
  const trashRoot = join(base, 'trash')
  const trashDirs = await readdir(trashRoot)
  check('delete: moved into trash dir', trashDirs.length === 1 && trashDirs[0].startsWith('test-session-0001-'))

  // trashList
  const rows = await persistence.trashList()
  check('trashList: one row with header meta', rows.length === 1 && rows[0].sessionId === sid && rows[0].cwd === 'C:\\work\\demo' && typeof rows[0].movedAt === 'number')

  // trashRestore → back into the live store
  await registry.trashRestore(sid)
  const liveBack = await persistence.findLog(sid)
  check('trashRestore: artifact back in live store', liveBack !== undefined)
  check('trashRestore: trash emptied for that id', (await readdir(trashRoot)).length === 0)

  // generation naming: a directory that kept both the version-zero log and the
  // current generation must be read from the newest one
  const mixed = 'test-session-mixed'
  const mixedDir = await seed(root, mixed, 'session.jsonl', 'C:\\\\work\\\\stale')
  await writeFile(join(mixedDir, LOG_NAME), headerLine(mixed, 'C:\\\\work\\\\demo'))
  await registry.archiveSession(mixed)
  await registry.deleteSession(mixed)
  const mixedRow = (await persistence.trashList()).find((row) => row.sessionId === mixed)
  check('trashList: the newest generation wins over the legacy v0 log', mixedRow !== undefined && mixedRow.cwd === 'C:\\work\\demo', JSON.stringify(mixedRow))
  await registry.trashRestore(mixed)
  check('trashRestore: both generations survive the round trip', (await readdir(mixedDir)).length === 2)

  // delete again, then purge
  await registry.deleteSession(sid)
  await registry.trashPurge(sid)
  check('trashPurge: trashed dir removed', (await readdir(trashRoot)).length === 0)

  // recreate the session, delete again, then trashEmpty
  await seed(root, sid, LOG_NAME)
  await registry.archiveSession(sid)
  await registry.deleteSession(sid)
  await registry.trashEmpty()
  check('trashEmpty: trash emptied', (await readdir(trashRoot)).length === 0)

  // live-session refusal
  registry.ctx.get = () => ({ get: (id) => (id === sid ? {} : undefined) })
  await seed(root, sid, LOG_NAME)
  let liveError = null
  try {
    await registry.deleteSession(sid)
  } catch (error) {
    liveError = error
  }
  check('delete: live session refused with session-live', liveError !== null && liveError.code === 'session-live')

  // unknown-session rejection
  registry.ctx.get = () => ({ get: () => undefined })
  let unknownError = null
  try {
    await registry.deleteSession('does-not-exist-xyz')
  } catch (error) {
    unknownError = error
  }
  check('delete: unknown session refused with session-not-found', unknownError !== null && unknownError.code === 'session-not-found')

  // legacy host: `findLog` returns the bare path string and logs keep the
  // version-zero name — the same delete path must still work
  const legacyRoot = join(base, 'legacy-sessions')
  await mkdir(legacyRoot, { recursive: true })
  const legacyPersistence = makePersistence(legacyRoot, { findLogShape: 'string', logName: 'session.jsonl' })
  const legacyRegistry = makeRegistry(legacyPersistence)
  apply({
    get(name) {
      if (name === 'sessionPersistence') return legacyPersistence
      if (name === 'workspaceRegistry') return legacyRegistry
      return undefined
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  })
  const legacyId = 'test-session-legacy'
  await seed(legacyRoot, legacyId, 'session.jsonl')
  await legacyRegistry.archiveSession(legacyId)
  await legacyRegistry.deleteSession(legacyId)
  const legacyRows = await legacyPersistence.trashList()
  check('legacy host: string-shaped findLog still deletes and lists', legacyRows.length === 1 && legacyRows[0].sessionId === legacyId, JSON.stringify(legacyRows))
  await legacyPersistence.trashRestore(legacyId)
  check('legacy host: string-shaped findLog still restores', (await legacyPersistence.findLog(legacyId)) !== undefined)

  console.log('\n[host logs]')
  for (const line of logs) console.log('  ' + line)
} finally {
  await rm(base, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nALL HOST LOGIC CHECKS PASSED')
