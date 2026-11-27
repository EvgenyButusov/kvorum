# derive

Commands:

- `admin-cli derive replay <dao_source_id> [--from-block N] --confirm --production [--dry-run]`
- `admin-cli derive unpark [--source <type...>] [--max-attempts N] --confirm --production [--dry-run]`
- `admin-cli derive verify <proposal_external_id>`

Notes:

- `replay` only resets derivation watermarks; the running indexer performs actual re-derivation.
- `unpark` resets the attempt count for un-derived rows at or past the projection ceiling, leaving
  `derived_at` untouched. Prefer it over `replay` for recovering parked rows; see
  [derivation-parked-rows.md](../runbooks/derivation-parked-rows.md).
- `verify` scope: verifies proposal-row fields only; does not re-decode actions.
