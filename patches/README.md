# Reference patches for the in-box archive-management backend

These unified diffs are the exact local changes that originally implemented the
archive/trash backend inside the DSH host packages (against the npm-published
`0.1.0-rc.6` builds — the app-bundled rc.5 is functionally identical apart from
build-path/hash noise). They are kept here **for reference and review**: the
plugin's host half (`dsh/index.js`) re-implements this behavior at runtime via
feature detection, so you normally do **not** need to apply them.

| File | What it adds |
| --- | --- |
| `01-dsh-workspace-lib-index.patch` | `WorkspaceLiveSessionError`; registry `unarchiveSession` / `deleteSession` / `trashList` / `trashRestore` / `trashPurge` / `trashEmpty` |
| `02-dsh-session-persistence-jsonl-lib-index.patch` | trash root + `moveToTrash`; `remove()` moves to `$DSH_HOME/trash` instead of deleting; `trashList` / `trashRestore` / `trashPurge` / `trashEmpty` |
| `03-dsh-host-apiproxy-lib-index.patch` | RPC routes + wire schemas + client methods for the six workspace ops; `sessionClosers` so archiving deactivates the live agent; `host/session-removed` stream frame |
| `04-dsh-host-apiproxy-workspace-schema.patch` | `workspace.schema.js` wire schemas (types mirror) |
| `05a/05b-dsh-host-apiproxy-fetch-*.patch` | fetch-based wire: `UNARY_ROUTES` + client method surface |
| `06-dsh-host-apiproxy-api-proxy-mirror.patch` | `api-proxy.js` source-mapped mirror of the same host changes |

Client-side patches (client-runtime manager methods, client-connection error
codes, client-ui-workspace section, etc.) are **not** included: the plugin
replaces them — its browser half registers the settings section and talks to
the backend through the native runtime API when present or the plugin's own
HTTP route when not.
