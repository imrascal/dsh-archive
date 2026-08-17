// Eval-check for the dsh-archive client bundle: evaluates the lazy-CJS
// factory with a fake window.__ModuleLoader__ and real react, then runs
// apply(ctx) against a minimal mocked ctx (slots/locale/workspaces/sessions).
// Catches module-level evaluation errors and apply-level wiring errors
// without needing a browser.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Resolve react / react/jsx-runtime from the installed DSH host so the
// factory sees the exact runtime the browser uses.
const hostRequire = createRequire('C:/Applications/DeepSeek Harness/resources/host/node_modules/package.json')
const code = readFileSync(new URL('../dsh/client.js', import.meta.url), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

// Evaluate the bundle file (registers the entry via the fake loader).
const run = new Function('window', code + '\n;return window.__ModuleLoader__')
run(globalThis.window)

if (!captured) throw new Error('bundle did not call __ModuleLoader__.load')
if (captured.id !== '@imrascal/dsh-archive') throw new Error(`unexpected bundle id ${captured.id}`)

// Build the factory's require: real react + react/jsx-runtime from the host.
const requireShim = (spec) => {
  if (spec === 'react') return hostRequire('react')
  if (spec === 'react/jsx-runtime') return hostRequire('react/jsx-runtime')
  throw new Error(`unexpected require target "${spec}"`)
}

const exportsObj = captured.factory(requireShim)
console.log('[eval] factory evaluated OK')
console.log('[eval] exports:', Object.keys(exportsObj))
if (typeof exportsObj.apply !== 'function') throw new Error('apply is not a function')
if (!Array.isArray(exportsObj.inject)) throw new Error('inject is not an array')

// --- minimal mocked ctx ---------------------------------------------------
const registered = []
const localeDicts = {}
const effects = []

const ctx = {
  locale: {
    bind(ns) {
      return (key, params) => {
        const dict = localeDicts[ns] || {}
        let text = dict[key] || key
        if (params) for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v))
        return text
      }
    },
    register(ns, dicts) {
      Object.assign(localeDicts, dicts)
      console.log('[ctx] locale.register:', ns, '->', Object.keys(dicts.zh).length, 'zh keys,', Object.keys(dicts.en).length, 'en keys')
    },
  },
  slots: {
    entries() {
      return []
    },
    inject(key, callback) {
      registered.push({ key, callback })
      console.log('[ctx] slots.inject:', key)
    },
    register(descriptor, component) {
      console.log('[ctx] slots.register:', descriptor.name, 'id=', descriptor.id, 'order=', descriptor.order, 'component=', typeof component)
      return { descriptor, component }
    },
  },
  workspaces: {
    // simulate the PATCHED client runtime service face: the service layer
    // unwraps wire envelopes, so trashList() returns the rows array directly
    trashList: () => Promise.resolve([]),
    unarchiveSession: () => Promise.resolve(),
    deleteSession: () => Promise.resolve(),
    trashRestore: () => Promise.resolve(),
    trashPurge: () => Promise.resolve(),
    trashEmpty: () => Promise.resolve(),
    manager: { refresh: () => Promise.resolve() },
  },
  sessions: { refresh: () => Promise.resolve() },
  effect(fn, label) {
    effects.push({ fn, label })
    console.log('[ctx] effect:', label)
  },
}

exportsObj.apply(ctx)
console.log('[apply] apply() ran without throwing')

// Run the effects (dictionary registration + styles + slot inject).
for (const { fn, label } of effects) {
  const cleanup = fn()
  if (typeof cleanup === 'function') cleanup() // styles cleanup path
}
console.log('[apply] effects ran; registered slot callbacks:', registered.length)

// Drive the inject factory to ensure the action props resolve.
const settingsSection = registered.find((r) => r.key === 'settings.section')
if (!settingsSection) throw new Error('settings.section slot was not injected')
const result = settingsSection.callback()
if (!result || typeof result.component !== 'function') throw new Error('slot registration did not return { component }')
console.log('[slot] section registration OK; component =', result.component.name || '(anonymous)')

// Exercise the inject factory's action set.
const injected = result.descriptor.inject()
console.log('[slot] injected actions:', Object.keys(injected))
await injected.loadTrash().then((rows) => {
  if (!Array.isArray(rows)) throw new Error('loadTrash did not return an array')
  console.log('[slot] loadTrash() ->', rows.length, 'rows (native path)')
})
await injected.trashEmpty()
console.log('[slot] trashEmpty() resolved (native path)')

console.log('\nALL CLIENT EVAL CHECKS PASSED')
