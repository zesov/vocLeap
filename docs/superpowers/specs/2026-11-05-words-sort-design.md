# Words List Sorting

Date: 2026-11-05
Status: Approved

## Problem

The words list always returns words newest-first (`created_at DESC`). Users
cannot view their vocabulary by date ascending or alphabetically, which the
Google Translate saved-translations page supports.

Infinite pagination must keep working: sorting has to happen in the database so
every page uses the same order.

## Requirements

- Add a sort control to `/words` with four options:
  - Newest first (default)
  - Oldest first
  - A–Z
  - Z–A
- Sorting must apply across pages, not only to the rows already loaded.
- Changing the sort resets the list and reloads from offset 0.
- Alphabetical sorting uses the saved `word` text.
- Sorting is not persisted across reloads.

## Design

### API

`GET /api/words` accepts an optional `sort` query parameter:

```text
GET /api/words?limit=30&offset=0&sort=alpha_asc
```

Allowed values map to a fixed `ORDER BY` clause:

| `sort` | `ORDER BY` |
| --- | --- |
| `date_desc` (default) | `created_at DESC, id DESC` |
| `date_asc` | `created_at ASC, id ASC` |
| `alpha_asc` | `word COLLATE NOCASE ASC, id ASC` |
| `alpha_desc` | `word COLLATE NOCASE DESC, id DESC` |

Unknown values fall back to `date_desc`; the parameter is never interpolated
into SQL directly. The response includes the resolved `sort` value alongside
`words`, `total`, `limit`, `offset`, and `hasMore`.

### Database

`getAllWords(userId, limit, offset, sort)` keeps its current return shape
(`{ words, total }`) and picks the `ORDER BY` clause from the whitelist. The
count query is unchanged.

The `id` tie-breaker keeps pagination stable when multiple words share the same
`created_at` second.

### UI

`app/(app)/words/page.tsx`:

- `const [sort, setSort] = useState<SortOption>("date_desc")`
- `fetchWords(offset, append, sort)` appends `&sort=${sort}` to the request.
- Changing `sort` clears `words`, resets `offset` to 0, restores `hasMore`, and
  loads the first page.
- The existing `Select` component renders the four options next to
  `Import Words`; on narrow screens the controls stack.
- The initial loading, empty, and "Loading more words..." states are unchanged.

### Error handling

Malformed `limit`/`offset`/`sort` values fall back to safe defaults instead of
throwing. A failed page load keeps the already-loaded rows and logs the error,
matching the current page behaviour.

### Testing

Playwright coverage in `tests/e2e/`:

1. API: seed words, then request each `sort` value and assert the returned
   order for the first page.
2. API: assert an invalid `sort` falls back to `date_desc`.
3. UI: select `A–Z`, assert the first visible card, then scroll to trigger the
   next page and assert the appended card keeps the alphabetical order.

### Out of scope

- Search or filtering controls.
- Persisting the selected sort in `localStorage` or the URL.
- Sorting by translation or other columns.
