'use strict';

/**
 * @module dsh-archive/client
 * @description Client-side half of the dsh-archive plugin.
 * Registers the "Archived Sessions" section in the DSH settings panel
 * and provides restore/delete/trash management UI.
 */

// DeepSeek Harness (dsh) plugin — browser half of the archive-session manager.
//
// Registers the "存档会话 / Archived Sessions" settings section (the
// standard `settings.section` slot): archived sessions can be restored
// individually or all at once, or moved to the trash; the trash section can
// restore, permanently purge, or empty entries. This is a faithful port of
// the ArchivedSessionsSection that used to live inside
// @deepseek-ai/dsh-client-ui-workspace (see the repo README).
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory), so no build step. Requires only `react` and
// `react/jsx-runtime`, both of which the shell's static module table serves
// to every plugin bundle; everything else (CSS, modals, buttons) is
// self-contained. The action props feature-detect the native client-runtime
// API (`ctx.workspaces.unarchiveSession/trashList/...`, present on hosts
// whose runtime carries the archive patches) and fall back to the plugin's
// own host route `/dsh-archive/session` when it is absent — so the feature
// survives app updates that revert the client patches.
window.__ModuleLoader__.load({
  id: '@imrascal/dsh-archive',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')
    var react_jsx_runtime = require('react/jsx-runtime')

    var NS = 'dshArchive'

    // ---------------------------------------------------------------------
    // Locale dictionaries (values mirror the in-box workspace dictionary)
    // ---------------------------------------------------------------------
    var zh = {
      'nav': '存档会话',
      'title': '存档会话',
      'intro': '归档的会话会从侧边栏隐藏，但会话记录会保留。恢复后会话将回到原来的位置。',
      'empty': '暂无已归档的会话',
      'restore': '恢复',
      'restoreAll': '全部恢复',
      'delete': '删除',
      'delete.title': '删除会话',
      'delete.desc': '将把会话“{name}”移入回收站（~/.dsh/trash），可随时恢复。',
      'delete.confirm': '移入回收站',
      'delete.pending': '正在删除…',
      'delete.live': '该会话当前仍处于打开状态，无法删除。请先切换到其他会话，或重启应用后再试。',
      'trash.title': '回收站',
      'trash.empty': '回收站为空',
      'trash.restore': '恢复',
      'trash.purge': '彻底删除',
      'trash.emptyAll': '清空回收站',
      'trash.confirm.title': '清空回收站',
      'trash.confirm.desc': '将永久删除回收站中的全部 {n} 个会话，此操作不可撤销。',
      'trash.confirm.confirm': '清空',
      'trash.purge.desc': '将永久删除“{name}”的回收站记录，此操作不可撤销。',
      'trash.pending': '正在处理…',
      'error': '操作失败：{message}',
      'time.now': '刚刚',
      'time.minutes': '{n}分钟',
      'time.hours': '{n}小时',
      'time.days': '{n}天',
      'time.months': '{n}个月',
      'time.years': '{n}年',
      'time.ago': '{t}前',
      'cancel': '取消',
      'close': '关闭',
      'session.new': '新会话',
      'group.ungrouped': '未分组',
      'sessions.count.one': '{n} 个会话',
      'sessions.count.other': '{n} 个会话'
    }
    var en = {
      'nav': 'Archived Sessions',
      'title': 'Archived Sessions',
      'intro': 'Archived sessions are hidden from the sidebar but their records are kept. Restoring returns each session to its original position.',
      'empty': 'No archived sessions',
      'restore': 'Restore',
      'restoreAll': 'Restore all',
      'delete': 'Delete',
      'delete.title': 'Delete session',
      'delete.desc': 'This moves the session “{name}” to the trash (~/.dsh/trash). It can be restored at any time.',
      'delete.confirm': 'Move to trash',
      'delete.pending': 'Deleting…',
      'delete.live': 'This session is currently open and cannot be deleted. Switch to another session first, or restart the app and try again.',
      'trash.title': 'Trash',
      'trash.empty': 'Trash is empty',
      'trash.restore': 'Restore',
      'trash.purge': 'Delete permanently',
      'trash.emptyAll': 'Empty trash',
      'trash.confirm.title': 'Empty trash',
      'trash.confirm.desc': 'This permanently deletes all {n} trashed sessions. This cannot be undone.',
      'trash.confirm.confirm': 'Empty',
      'trash.purge.desc': 'This permanently deletes “{name}” from the trash. This cannot be undone.',
      'trash.pending': 'Working…',
      'error': 'Operation failed: {message}',
      'time.now': 'now',
      'time.minutes': '{n}min',
      'time.hours': '{n}h',
      'time.days': '{n}d',
      'time.months': '{n}mo',
      'time.years': '{n}y',
      'time.ago': '{t} ago',
      'cancel': 'Cancel',
      'close': 'Close',
      'session.new': 'New session',
      'group.ungrouped': 'Ungrouped',
      'sessions.count.one': '{n} session',
      'sessions.count.other': '{n} sessions'
    }

    // ---------------------------------------------------------------------
    // Styles (self-contained; same design tokens as the in-box section)
    // ---------------------------------------------------------------------
    var CSS_ID = '@imrascal/dsh-archive/ArchivedSessions.css'
    var CSS =
      '.dsha-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}' +
      '.dsha-header{align-items:baseline;gap:8px;display:flex}' +
      '.dsha-title{color:var(--dsw-alias-label-primary);margin:0;font-size:18px;font-weight:600;line-height:24px}' +
      '.dsha-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:13px;line-height:20px}' +
      '.dsha-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}' +
      '.dsha-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;line-height:20px}' +
      '.dsha-empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}' +
      '.dsha-rows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}' +
      '.dsha-row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;align-items:center;gap:12px;padding:12px 14px;display:flex}' +
      '.dsha-rowText{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}' +
      '.dsha-rowTitle{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}' +
      '.dsha-rowMeta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px;overflow:hidden}' +
      '.dsha-restoreButton,.dsha-restoreAll,.dsha-deleteButton{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:16px;flex:none;justify-content:center;align-items:center;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}' +
      '.dsha-restoreButton,.dsha-restoreAll{color:var(--dsw-alias-label-primary)}' +
      '.dsha-deleteButton{color:var(--dsw-alias-state-error-primary)}' +
      '.dsha-restoreButton:hover:not(:disabled),.dsha-restoreAll:hover:not(:disabled),.dsha-deleteButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.dsha-restoreButton:disabled,.dsha-restoreAll:disabled,.dsha-deleteButton:disabled{cursor:default;opacity:.5}' +
      '.dsha-restoreAll{margin-left:auto}' +
      '.dsha-rowActions{flex:none;align-items:center;gap:6px;display:flex}' +
      '.dsha-modalStatus{margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}' +
      '.dsha-trashBlock{border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px;flex-direction:column;gap:12px;display:flex}' +
      '.dsha-modalOverlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}' +
      '.dsha-modalMask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}' +
      '.dsha-modalPanel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:440px;max-width:calc(100vw - 48px);border-radius:20px;box-shadow:var(--dsw-shadow-lv3);flex-direction:column;gap:12px;padding:20px;display:flex}' +
      '.dsha-modalTitle{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600;line-height:24px}' +
      '.dsha-modalDesc{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}' +
      '.dsha-modalFooter{justify-content:flex-end;gap:8px;display:flex}'

    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = '@imrascal/dsh-archive'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function removeStyles() {
      if (typeof document === 'undefined') return
      var tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']')
      if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag)
    }

    // ---------------------------------------------------------------------
    // Small helpers (ported from the in-box workspace client)
    // ---------------------------------------------------------------------
    /** Compact relative time bucket: { unit, n } — "now" under a minute. */
    function relativeTime(updatedAt, now) {
      var MIN = 6e4
      var HOUR = 36e5
      var DAY = 864e5
      var diff = Math.max(0, now - updatedAt)
      if (diff < MIN) return { unit: 'now', n: 0 }
      if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
      if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
      if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
      if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
      return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
    }

    /** Hover-card style relative time ("刚刚"/"5分钟前"). */
    function hoverTimeLabel(updatedAt, now, t) {
      var bucket = relativeTime(updatedAt, now)
      return bucket.unit === 'now' ? t('time.now') : t('time.ago', { t: t('time.' + bucket.unit, { n: bucket.n }) })
    }

    /** Directory display label: basename of the path; ungrouped fallback. */
    function workspaceLabel(cwd, t) {
      if (cwd === void 0 || cwd === '') return t('group.ungrouped')
      var base = String(cwd).replace(/[/\\]+$/, '').split(/[/\\]/).pop()
      return base !== void 0 && base !== '' ? base : cwd
    }

    // ---------------------------------------------------------------------
    // Fallback HTTP client (used when the native ctx.workspaces API is absent)
    // ---------------------------------------------------------------------
    function httpCall(payload, attempt) {
      attempt = attempt || 1
      var delay = function () {
        return new Promise(function (resolve) { setTimeout(resolve, 1000 * attempt) })
      }
      return fetch('/dsh-archive/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { ok: false, code: 'bad-response', message: 'plugin API returned a non-JSON response' }
          })
        })
        .then(function (body) {
          if (body !== null && body.ok === true) return body.value
          // Transient unavailability during app boot: the host's registry
          // service may not be ready yet — retry briefly with backoff.
          if (body && body.code === 'unavailable' && attempt < 3) {
            return delay().then(function () { return httpCall(payload, attempt + 1) })
          }
          var error = new Error(body && body.message ? body.message : 'operation failed')
          error.code = body && body.code ? body.code : 'unknown'
          throw error
        })
        .catch(function (error) {
          // Network-level failures (route not yet mounted mid-restart) get the
          // same bounded retry; business errors carry a code and surface at once.
          if (attempt < 3 && !(error && error.code)) {
            return delay().then(function () { return httpCall(payload, attempt + 1) })
          }
          throw error
        })
    }

    /** Whether the native client-runtime API is present right now. */
    function nativeTrash(ctx) {
      return typeof ctx.workspaces === 'object' && ctx.workspaces !== null && typeof ctx.workspaces.trashList === 'function'
    }

    /**
     * Best-effort resync of the session/workspace stores after a fallback op.
     * BOTH stores must be refreshed, never just the first one that exists: the
     * workspaces view drops the deleted session (the host detaches it from its
     * entity and clears its sessionPaths entry), but if the sessions list is
     * not refreshed too, the stale row survives and the sidebar renders it in
     * the ungrouped bucket — it is no longer accounted by any workspace yet
     * still present in the list (regression observed on the trash path).
     */
    function resync(ctx) {
      var jobs = []
      try {
        if (ctx.workspaces && ctx.workspaces.manager && typeof ctx.workspaces.manager.refresh === 'function') {
          jobs.push(Promise.resolve(ctx.workspaces.manager.refresh()).catch(function () {}))
        }
      } catch (error) {
        /* fall through */
      }
      try {
        if (ctx.sessions && typeof ctx.sessions.refresh === 'function') {
          jobs.push(Promise.resolve(ctx.sessions.refresh()).catch(function () {}))
        }
      } catch (error) {
        /* ignore */
      }
      return Promise.all(jobs).then(function () {})
    }

    // ---------------------------------------------------------------------
    // The settings section component (port of ArchivedSessionsSection)
    // ---------------------------------------------------------------------
    function ArchivedSessionsSection(props) {
      var useSessions = props.useSessions
      var useWorkspaces = props.useWorkspaces
      var t = props.t
      var unarchiveSession = props.unarchiveSession
      var deleteSession = props.deleteSession
      var loadTrash = props.loadTrash
      var trashRestore = props.trashRestore
      var trashPurge = props.trashPurge
      var trashEmpty = props.trashEmpty

      var sessions = useSessions(function (s) { return s.byId })
      var archivedIds = useWorkspaces(function (s) { return s.archivedSessionIds })
      var workspaces = useWorkspaces(function (s) { return s.items })
      var nowState = react.useState(function () { return Date.now() })
      var now = nowState[0]
      var setNow = nowState[1]
      react.useEffect(function () {
        var timer = setInterval(function () { setNow(Date.now()) }, 60000)
        return function () { clearInterval(timer) }
      }, [])
      var busyState = react.useState(function () { return new Set() })
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = react.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var deleteTargetState = react.useState(null)
      var deleteTarget = deleteTargetState[0]
      var setDeleteTarget = deleteTargetState[1]
      var deletingState = react.useState(false)
      var deleting = deletingState[0]
      var setDeleting = deletingState[1]
      var trashRowsState = react.useState([])
      var trashRows = trashRowsState[0]
      var setTrashRows = trashRowsState[1]
      var trashConfirmState = react.useState(null)
      var trashConfirm = trashConfirmState[0]
      var setTrashConfirm = trashConfirmState[1]
      var trashWorkingState = react.useState(false)
      var trashWorking = trashWorkingState[0]
      var setTrashWorking = trashWorkingState[1]

      var fail = function (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
      var refreshTrash = function () {
        Promise.resolve(loadTrash()).then(setTrashRows).catch(fail)
      }
      react.useEffect(function () {
        refreshTrash()
        /* mount-only refresh */
        return void 0
      }, [])

      var workspaceLabelOf = {}
      for (var wi = 0; wi < workspaces.length; wi++) {
        var workspace = workspaces[wi]
        var ids = workspace.sessionIds || []
        for (var si = 0; si < ids.length; si++) {
          if (workspaceLabelOf[ids[si]] === void 0) workspaceLabelOf[ids[si]] = workspace.title
        }
      }
      var rows = archivedIds.map(function (id) {
        return { id: id, summary: sessions[id] }
      }).sort(function (a, b) {
        return ((b.summary && b.summary.updatedAt) || 0) - ((a.summary && a.summary.updatedAt) || 0)
      })

      var restore = function (sessionId) {
        if (busy.has(sessionId)) return
        setError(null)
        setBusy(function (previous) { var next = new Set(previous); next.add(sessionId); return next })
        Promise.resolve(unarchiveSession(sessionId))
          .then(function () { return resyncOnAction() })
          .catch(fail)
          .finally(function () {
            setBusy(function (previous) { var next = new Set(previous); next.delete(sessionId); return next })
          })
      }
      var restoreAll = function () {
        if (rows.length === 0 || busy.size > 0) return
        var ids = rows.map(function (row) { return row.id })
        setError(null)
        setBusy(function (previous) { var next = new Set(previous); ids.forEach(function (id) { next.add(id) }); return next })
        Promise.all(ids.map(function (sessionId) { return Promise.resolve(unarchiveSession(sessionId)) }))
          .then(function () { return resyncOnAction() })
          .catch(fail)
          .finally(function () { setBusy(new Set()) })
      }
      var requestDelete = function (row) {
        if (busy.has(row.id)) return
        setError(null)
        setDeleteTarget(row)
      }
      var closeDelete = function () {
        if (deleting) return
        setDeleteTarget(null)
      }
      var confirmDelete = function () {
        if (deleteTarget === null || deleting) return
        setDeleting(true)
        setError(null)
        Promise.resolve(deleteSession(deleteTarget.id))
          .then(function () {
            refreshTrash()
            return resyncOnAction()
          })
          .catch(function (reason) {
            if (reason && reason.code === 'session-live') setError(t('delete.live'))
            else fail(reason)
          })
          .finally(function () {
            setDeleting(false)
            setDeleteTarget(null)
          })
      }
      var restoreTrashed = function (sessionId) {
        if (busy.has(sessionId) || trashWorking) return
        setError(null)
        setBusy(function (previous) { var next = new Set(previous); next.add(sessionId); return next })
        Promise.resolve(trashRestore(sessionId))
          .then(function () {
            refreshTrash()
            return resyncOnAction()
          })
          .catch(fail)
          .finally(function () {
            setBusy(function (previous) { var next = new Set(previous); next.delete(sessionId); return next })
          })
      }
      var requestEmptyTrash = function () {
        if (trashRows.length === 0 || trashWorking) return
        setError(null)
        setTrashConfirm({ kind: 'empty' })
      }
      var requestPurgeTrash = function (row) {
        if (trashWorking) return
        setError(null)
        setTrashConfirm({ kind: 'purge', row: row })
      }
      var closeTrashConfirm = function () {
        if (trashWorking) return
        setTrashConfirm(null)
      }
      var confirmTrash = function () {
        if (trashConfirm === null || trashWorking) return
        setTrashWorking(true)
        setError(null)
        var operation = trashConfirm.kind === 'empty'
          ? Promise.resolve(trashEmpty())
          : Promise.resolve(trashPurge(trashConfirm.row.sessionId))
        operation.then(refreshTrash).catch(fail).finally(function () {
          setTrashWorking(false)
          setTrashConfirm(null)
        })
      }

      // resync after a fallback-path action (no-op when the action was native)
      var resyncOnAction = function () {
        if (nativeTrash(globalCtx)) return Promise.resolve()
        return resync(globalCtx)
      }

      var deleteTargetTitle = deleteTarget === null
        ? ''
        : deleteTarget.summary === void 0
          ? deleteTarget.id
          : deleteTarget.summary.blank
            ? t('session.new')
            : deleteTarget.summary.displayTitle
      var trashConfirmName = trashConfirm !== null && trashConfirm.kind === 'purge'
        ? workspaceLabel(trashConfirm.row.cwd, t) || trashConfirm.row.sessionId
        : ''

      return react_jsx_runtime.jsx('div', {
        className: 'dsha-section',
        children: [
          react_jsx_runtime.jsx('div', {
            className: 'dsha-header',
            children: [
              react_jsx_runtime.jsx('h2', { className: 'dsha-title', children: t('title') }),
              rows.length > 0
                ? react_jsx_runtime.jsx('span', { className: 'dsha-count', children: t('sessions.count.other', { n: rows.length }) })
                : null,
              rows.length > 1
                ? react_jsx_runtime.jsx('button', {
                    type: 'button',
                    className: 'dsha-restoreAll',
                    disabled: busy.size > 0,
                    onClick: restoreAll,
                    children: t('restoreAll')
                  })
                : null
            ]
          }),
          react_jsx_runtime.jsx('p', { className: 'dsha-intro', children: t('intro') }),
          error === null
            ? null
            : react_jsx_runtime.jsx('p', { className: 'dsha-error', role: 'alert', children: t('error', { message: error }) }),
          rows.length === 0
            ? react_jsx_runtime.jsx('p', { className: 'dsha-empty', children: t('empty') })
            : react_jsx_runtime.jsx('ul', {
                className: 'dsha-rows',
                children: rows.map(function (row) {
                  return react_jsx_runtime.jsx(
                    'li',
                    {
                      className: 'dsha-row',
                      children: [
                        react_jsx_runtime.jsx('div', {
                          className: 'dsha-rowText',
                          children: [
                            react_jsx_runtime.jsx('span', {
                              className: 'dsha-rowTitle',
                              children: row.summary === void 0 ? row.id : row.summary.blank ? t('session.new') : row.summary.displayTitle
                            }),
                            row.summary === void 0
                              ? null
                              : react_jsx_runtime.jsx('span', {
                                  className: 'dsha-rowMeta',
                                  children: (workspaceLabelOf[row.id] || t('group.ungrouped')) + ' · ' + hoverTimeLabel(row.summary.updatedAt, now, t)
                                })
                          ]
                        }),
                        react_jsx_runtime.jsx('div', {
                          className: 'dsha-rowActions',
                          children: [
                            react_jsx_runtime.jsx('button', {
                              type: 'button',
                              className: 'dsha-restoreButton',
                              disabled: busy.has(row.id),
                              onClick: function () { restore(row.id) },
                              children: t('restore')
                            }),
                            react_jsx_runtime.jsx('button', {
                              type: 'button',
                              className: 'dsha-deleteButton',
                              disabled: busy.has(row.id),
                              onClick: function () { requestDelete(row) },
                              children: t('delete')
                            })
                          ]
                        })
                      ]
                    },
                    row.id
                  )
                })
              }),
          // delete confirmation modal
          deleteTarget !== null
            ? react_jsx_runtime.jsx('div', {
                className: 'dsha-modalOverlay',
                children: [
                  react_jsx_runtime.jsx('div', { className: 'dsha-modalMask', onClick: closeDelete }),
                  react_jsx_runtime.jsx('div', {
                    className: 'dsha-modalPanel',
                    children: [
                      react_jsx_runtime.jsx('h3', { className: 'dsha-modalTitle', children: t('delete.title') }),
                      react_jsx_runtime.jsx('p', {
                        className: 'dsha-modalDesc',
                        children: t('delete.desc', { name: deleteTargetTitle })
                      }),
                      deleting
                        ? react_jsx_runtime.jsx('div', { className: 'dsha-modalStatus', role: 'status', children: t('delete.pending') })
                        : null,
                      react_jsx_runtime.jsx('div', {
                        className: 'dsha-modalFooter',
                        children: [
                          react_jsx_runtime.jsx('button', {
                            type: 'button',
                            className: 'dsha-restoreButton',
                            disabled: deleting,
                            onClick: closeDelete,
                            children: t('cancel')
                          }),
                          react_jsx_runtime.jsx('button', {
                            type: 'button',
                            className: 'dsha-deleteButton',
                            disabled: deleting,
                            onClick: confirmDelete,
                            children: t('delete.confirm')
                          })
                        ]
                      })
                    ]
                  })
                ]
              })
            : null,
          // trash block
          react_jsx_runtime.jsx('div', {
            className: 'dsha-trashBlock',
            children: [
              react_jsx_runtime.jsx('div', {
                className: 'dsha-header',
                children: [
                  react_jsx_runtime.jsx('h3', { className: 'dsha-title', children: t('trash.title') }),
                  trashRows.length > 0
                    ? react_jsx_runtime.jsx('span', { className: 'dsha-count', children: t('sessions.count.other', { n: trashRows.length }) })
                    : null,
                  trashRows.length > 0
                    ? react_jsx_runtime.jsx('button', {
                        type: 'button',
                        className: 'dsha-restoreAll',
                        disabled: trashWorking,
                        onClick: requestEmptyTrash,
                        children: t('trash.emptyAll')
                      })
                    : null
                ]
              }),
              trashRows.length === 0
                ? react_jsx_runtime.jsx('p', { className: 'dsha-empty', children: t('trash.empty') })
                : react_jsx_runtime.jsx('ul', {
                    className: 'dsha-rows',
                    children: trashRows.map(function (row) {
                      return react_jsx_runtime.jsx(
                        'li',
                        {
                          className: 'dsha-row',
                          children: [
                            react_jsx_runtime.jsx('div', {
                              className: 'dsha-rowText',
                              children: [
                                react_jsx_runtime.jsx('span', {
                                  className: 'dsha-rowTitle',
                                  children: workspaceLabel(row.cwd, t) || row.sessionId
                                }),
                                react_jsx_runtime.jsx('span', {
                                  className: 'dsha-rowMeta',
                                  children: hoverTimeLabel(row.movedAt, now, t) + ' · ' + row.sessionId
                                })
                              ]
                            }),
                            react_jsx_runtime.jsx('div', {
                              className: 'dsha-rowActions',
                              children: [
                                react_jsx_runtime.jsx('button', {
                                  type: 'button',
                                  className: 'dsha-restoreButton',
                                  disabled: busy.has(row.sessionId) || trashWorking,
                                  onClick: function () { restoreTrashed(row.sessionId) },
                                  children: t('trash.restore')
                                }),
                                react_jsx_runtime.jsx('button', {
                                  type: 'button',
                                  className: 'dsha-deleteButton',
                                  disabled: trashWorking,
                                  onClick: function () { requestPurgeTrash(row) },
                                  children: t('trash.purge')
                                })
                              ]
                            })
                          ]
                        },
                        row.sessionId
                      )
                    })
                  }),
              // trash confirmation modal
              trashConfirm !== null
                ? react_jsx_runtime.jsx('div', {
                    className: 'dsha-modalOverlay',
                    children: [
                      react_jsx_runtime.jsx('div', { className: 'dsha-modalMask', onClick: closeTrashConfirm }),
                      react_jsx_runtime.jsx('div', {
                        className: 'dsha-modalPanel',
                        children: [
                          react_jsx_runtime.jsx('h3', {
                            className: 'dsha-modalTitle',
                            children: trashConfirm.kind === 'empty' ? t('trash.confirm.title') : t('trash.purge')
                          }),
                          react_jsx_runtime.jsx('p', {
                            className: 'dsha-modalDesc',
                            children: trashConfirm.kind === 'empty'
                              ? t('trash.confirm.desc', { n: trashRows.length })
                              : t('trash.purge.desc', { name: trashConfirmName })
                          }),
                          trashWorking
                            ? react_jsx_runtime.jsx('div', { className: 'dsha-modalStatus', role: 'status', children: t('trash.pending') })
                            : null,
                          react_jsx_runtime.jsx('div', {
                            className: 'dsha-modalFooter',
                            children: [
                              react_jsx_runtime.jsx('button', {
                                type: 'button',
                                className: 'dsha-restoreButton',
                                disabled: trashWorking,
                                onClick: closeTrashConfirm,
                                children: t('cancel')
                              }),
                              react_jsx_runtime.jsx('button', {
                                type: 'button',
                                className: 'dsha-deleteButton',
                                disabled: trashWorking,
                                onClick: confirmTrash,
                                children: trashConfirm.kind === 'empty' ? t('trash.confirm.confirm') : t('trash.purge')
                              })
                            ]
                          })
                        ]
                      })
                    ]
                  })
                : null
            ]
          })
        ]
      })
    }

    // ---------------------------------------------------------------------
    // Cordis client entry
    // ---------------------------------------------------------------------
    var inject = ['slots', 'sessions', 'workspaces', 'locale']
    // The shared ctx captured for fallback-path store resyncs (set in apply).
    var globalCtx = null

    function apply(ctx) {
      globalCtx = ctx
      var t = ctx.locale.bind(NS)
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }) }, 'dsh-archive: dictionaries')
      ctx.effect(function () {
        injectStyles()
        return function () { removeStyles() }
      }, 'dsh-archive: styles')

      var registered = false
      ctx.slots.inject('settings.section', function () {
        if (registered) return
        // Guard: if the in-box workspace client still registers the same
        // section id, stand down instead of duplicating the entry.
        try {
          var existing = ctx.slots.entries('settings.section').some(function (entry) {
            return entry.options && entry.options.id === 'archived-sessions'
          })
          if (existing) {
            console.warn('[dsh-archive] an "archived-sessions" settings section is already registered (in-box patch still present?) — plugin stood down; remove the in-box patch to let the plugin take over')
            return
          }
        } catch (error) {
          /* ledger not ready yet — proceed and let the slot dedupe */
        }
        registered = true
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'archived-sessions',
            order: 30,
            label: function () { return t('nav') },
            locale: NS,
            inject: function () {
              // Native availability is checked per call: the workspaces
              // service can be provided late (rc.7 gates the client runtime
              // behind injects), so freezing it at apply time would strand
              // the section on the fallback path forever.
              return {
                unarchiveSession: function (sessionId) {
                  return nativeTrash(ctx) ? ctx.workspaces.unarchiveSession(sessionId) : httpCall({ op: 'unarchive', sessionId: sessionId })
                },
                deleteSession: function (sessionId) {
                  return nativeTrash(ctx) ? ctx.workspaces.deleteSession(sessionId) : httpCall({ op: 'delete', sessionId: sessionId })
                },
                loadTrash: function () {
                  return nativeTrash(ctx) ? ctx.workspaces.trashList() : httpCall({ op: 'trashList' }).then(function (value) { return value.items })
                },
                trashRestore: function (sessionId) {
                  return nativeTrash(ctx) ? ctx.workspaces.trashRestore(sessionId) : httpCall({ op: 'trashRestore', sessionId: sessionId })
                },
                trashPurge: function (sessionId) {
                  return nativeTrash(ctx) ? ctx.workspaces.trashPurge(sessionId) : httpCall({ op: 'trashPurge', sessionId: sessionId })
                },
                trashEmpty: function () {
                  return nativeTrash(ctx) ? ctx.workspaces.trashEmpty() : httpCall({ op: 'trashEmpty' })
                }
              }
            }
          },
          ArchivedSessionsSection
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
