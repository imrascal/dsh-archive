# @imrascal/dsh-archive

[![CI](https://github.com/imrascal/dsh-archive/actions/workflows/ci.yml/badge.svg)](https://github.com/imrascal/dsh-archive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@imrascal/dsh-archive.svg)](https://www.npmjs.com/package/@imrascal/dsh-archive)

A DeepSeek Harness (DSH) plugin that manages **archived sessions and the trash** from the settings panel.

- **Archived Sessions**: review sessions that are hidden from the sidebar but keep their records;
  restore them individually or all at once, or move them to the trash.
- **Trash**: review deleted sessions; restore, permanently purge, or empty the whole trash.

Deletes are **reversible**: deleting a session moves it to the trash (`~/.dsh/trash`); only
*purge* / *empty trash* are permanent. Live (running) sessions refuse deletion with a clear message.

## Install

```bash
dsh plugin --profile web add github:imrascal/dsh-archive
```

Or from a local checkout:

```bash
dsh plugin --profile web add file:C:/path/to/dsh-archive
```

**Restart the app** after installing (the host half loads at boot), then refresh the page —
the section appears under Settings → Archived Sessions.

> `dsh plugin` forwards to pnpm, so `pnpm` must be on your PATH.

## How it works

This feature originally lived as in-box patches across 12 files
(`dsh-workspace`, `dsh-session-persistence-jsonl`, `dsh-host-apiproxy`, `dsh-client-runtime`,
`dsh-client-ui-workspace`, ... — reference diffs in [`patches/`](patches/)). This plugin re-implements
it as a standalone package with a **dual-path design**:

| Path | When | Behavior |
| --- | --- | --- |
| **Native** | host/client already carry the archive API | the client calls `ctx.workspaces.unarchiveSession / trashList / ...` directly — same RPC + store-frame sync as the in-box implementation |
| **Fallback** | an app update reverted host or client to stock | the host half **patches at runtime**: adds the trash layer to `sessionPersistence` and the archive API to `workspaceRegistry`; the client talks to the plugin's own `/dsh-archive/session` HTTP route |

So the feature **survives app updates**: trash data lives in `~/.dsh/trash` (data, not code) and the
archive set lives in the workspace registry's persisted state. Whatever the update does to the
packages, the plugin feature-detects at startup and fills in whatever is missing.

### Layout

```
dsh/index.js   host half: persistence trash layer + registry archive API + /dsh-archive/session route
dsh/client.js  browser half: "Archived Sessions" settings section (settings.section slot), no build, react only
cordis.patch.yml   bundle mount declaration
patches/       reference diffs for the in-box host patches (the client patches are replaced by this plugin)
scripts/       eval-check.mjs (client factory eval) and host-logic-test.mjs (host backend lifecycle)
```

## Migrating from an in-box patch (optional)

If your DSH install already carries the local archive-management patches (as this repo's dev
machine did), the plugin and the in-box patch would register the same `archived-sessions` section.
To migrate:

1. Restore `node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js` to the official
   release (drops the embedded ArchivedSessionsSection registration; the host patches may stay —
   the plugin detects them and no-ops).
2. Install and restart this plugin.
3. The plugin stands down automatically when the same section id already exists; once the in-box
   patch is removed the plugin takes over.

> To move the host side back to stock as well, back up `~/.dsh` first, reverse `patches/`, and let
> this plugin's host half re-add the backend. Trash data and the archive set are unaffected.

## Data safety

- Deleting a session moves it to `~/.dsh/trash/<sessionId>-<timestamp>/`, restorable at any time.
- *Delete permanently* / *Empty trash* are irreversible — both are guarded by a confirmation modal.
- Attachments are content-addressed and shared; deleting a session never deletes attachments.
- Live sessions cannot be deleted (`session-live`); the UI explains what to do.

## Compatibility

- Target DSH: `0.1.0-rc.5` and later — both the **native Web UI** (`dsh web` in a browser) and the
  **desktop GUI** (Electron window), which share the same host services and client bundle.
- Stock hosts (rc.5 unpatched, rc.6): the host half adds the trash layer and the registry API at
  runtime; the client falls back to `/dsh-archive/session`.
- Hosts that already carry the feature — rc.5 with the in-box patches, and **rc.7+ where upstream
  merged the same backend** (persistence trash layer, registry `unarchiveSession/deleteSession/
  trash*`, API-proxy routes, client-runtime methods): every step feature-detects and no-ops; the
  client calls the native `ctx.workspaces` API directly. Service availability is checked per call,
  so a service that is provided late (rc.7 gates the registry behind an inject) is picked up
  automatically instead of stranding the section on the fallback path.
- `deleteSession` is **fail-closed**: it refuses to run unless the persistence layer is trash-aware,
  so the plugin can never drive a stock hard-delete backend (nothing is removed on refusal).
- Host half shape-guards every patch; unrecognized services are skipped with a log line, never fatal.
- **Cordis 4 strict inject (0.2.1)**: DSH Desktop ships `@deepseek-ai/cordis` 4.x, where reading a
  service property off a context (`ctx.sessionPersistence`) is only allowed when the current fiber
  declares it in `inject`; undeclared reads throw `cannot get property "X" without inject`. The host
  half resolves services through `ctx.get(...)` and through the patched methods' receiver
  (`this.ctx`, which Cordis shadows to the registry's own fiber) — never through
  `registry.ctx` on a traceable service wrapper, whose `ctx` property resolves to the *caller's*
  context. On older Cordis 3.x hosts both spellings work; the 0.2.1 path is required on Cordis 4.
- **Dual-store client resync (0.2.2)**: after a fallback-path delete, the client refreshes BOTH the
  workspaces and the sessions stores. 0.2.0/0.2.1 only refreshed the workspaces view, so the deleted
  session stayed in the stale sessions list while dropping out of every workspace — the sidebar then
  rendered it in the **Ungrouped** bucket (visible until the next full reload).
- Platform: Windows / macOS / Linux (trash is plain Node `fs`; no platform assumptions).

## Development

```bash
npm install                                # fetches the @deepseek-ai/cordis devDependency
node scripts/host-logic-test.mjs        # host lifecycle: delete → trash → restore → purge → empty → live refusal
node scripts/host-robustness-test.mjs   # late service provision + fail-closed delete + route on-demand ensure
node scripts/cordis4-strict-test.mjs    # REAL Cordis 4 strict-inject regression (0.2.1: "without inject" fix)
node scripts/eval-check.mjs             # client bundle factory eval + apply + slot registration + late-service detection + dual-store resync (0.2.2)
```

## License

MIT
