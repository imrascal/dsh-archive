# Changelog

## 0.2.3

- fix: accept the generation record returned by `findLog` (`findLog` is no longer assumed to be a
  bare path string — deleting an archived session failed with `The "path" argument must be of type
  string. Received an instance of Object` before anything was moved)
- fix: resolve a session's log by listing its directory and preferring the highest format generation
  (`session.vN.jsonl[.zstd]`, not only `session.jsonl[.zstd]`), so trashed sessions written under a
  versioned name show up in trash list / restore

## 0.2.2

- fix: refresh BOTH client stores after fallback delete (no ungrouped ghost rows)

## 0.2.1

- fix: resolve host services via ctx.get / method receiver under Cordis 4 strict inject

## 0.2.0

- feat: DSH archive session manager plugin

## 0.1.0

- Initial development