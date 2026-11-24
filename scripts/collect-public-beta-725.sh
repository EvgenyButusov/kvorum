#!/usr/bin/env bash
# Read-only production diagnostics for public beta M1.1 / issue #725.
set -euo pipefail
umask 077

namespace="${KVORUM_NAMESPACE:-kvorum}"
indexer=deployment/kvorum-indexer
output_dir="$(mktemp -d docs/planning/validation/public-beta-725-diagnostics.XXXXXX)"

echo "Context: $(kubectl config current-context)" >&2
echo "Namespace: $namespace" >&2
echo "Writing diagnostic results to $output_dir" >&2

# Run inside the existing indexer: it already has the project's normal database,
# HTTP RPC and API configuration. Credentials stay inside the pod.
kubectl -n "$namespace" exec -i "$indexer" -c indexer -- node - > "$output_dir/report.json" <<'NODE'
const { createRequire } = require('node:module');
const { Client } = createRequire('/app/libs/db/package.json')('pg');
const { Interface } = createRequire('/app/libs/sources/compound/package.json')('ethers');

const report = {
  collected_at: new Date().toISOString(),
  build: process.env.BUILD_SHA || null,
  errors: [],
};
const targets = ['610', '611', '612', '613', '614', '615', '627', '628'];
const stateNames = ['pending', 'active', 'canceled', 'defeated', 'succeeded', 'queued', 'expired', 'executed'];
const compoundTypes = ['compound_governor_alpha', 'compound_governor_bravo', 'compound_governor_oz'];
const governor = new Interface(['function state(uint256) view returns (uint8)']);
const governorDeadline = new Interface(['function proposalDeadline(uint256) view returns (uint256)']);
const governorEvents = new Interface([
  'event ProposalQueued(uint256 id, uint256 eta)',
  'event ProposalExecuted(uint256 id)',
  'event VoteCast(address indexed voter, uint256 proposalId, uint8 support, uint256 weight, string reason)',
]);
const aave = new Interface(['function getProposalState(uint256) view returns (uint8)']);
const easyTrack = new Interface([
  'function getMotions() view returns (tuple(uint256 id, address evmScriptFactory, address creator, uint256 duration, uint256 startDate, uint256 snapshotBlock, uint256 objectionsThreshold, uint256 objectionsAmount, bytes32 evmScriptHash)[] motions)',
]);

// Never emit raw driver errors, URLs, headers, environment variables, or payloads.
function errorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,35}$/.test(code) ? code : 'unavailable';
}
async function section(name, fn) {
  try { report[name] = await fn(); }
  catch (error) { report.errors.push({ section: name, code: errorCode(error) }); }
}
function hex(value) { return '0x' + BigInt(value).toString(16); }
function isoTimestamp(value) { return new Date(Number(BigInt(value)) * 1000).toISOString(); }

async function withPg(fn) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    application_name: 'public-beta-725-readonly',
  });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function collectPg() {
  return withPg(async (client) => {
    const { rows: sources } = await client.query(`
      SELECT d.slug, ds.id AS dao_source_id, ds.source_type, ds.chain_id,
             ds.live_polling_enabled, ds.active_from_block, ds.active_to_block,
             ds.backfill_head_block, ds.poll_cursor_block
      FROM dao_source ds JOIN dao d ON d.id = ds.dao_id
      WHERE d.slug IN ('compound','aave','lido')
      ORDER BY d.slug, ds.source_type, ds.chain_id
    `);
    const { rows: proposals } = await client.query(`
      SELECT d.slug, p.id, p.source_type, p.source_id, p.state,
             p.state_updated_at, p.updated_at, p.voting_starts_at, p.voting_ends_at,
             p.voting_starts_block, p.voting_ends_block, p.eligible_voting_power,
             ds.id AS dao_source_id, ds.chain_id,
             ds.source_config ->> 'governor_address' AS governor_address,
             ds.source_config ->> 'governance_address' AS governance_address,
             ds.source_config ->> 'easy_track_address' AS easy_track_address,
             m.queued_at_block, m.last_reconcile_check_block
      FROM proposal p JOIN dao d ON d.id = p.dao_id
      LEFT JOIN dao_source ds ON ds.dao_id = p.dao_id AND ds.source_type = p.source_type
      LEFT JOIN compound_proposal_meta m ON m.proposal_id = p.id
      WHERE (d.slug = 'compound' AND p.source_type IN
        ('compound_governor_alpha','compound_governor_bravo','compound_governor_oz')
        AND (p.source_id = ANY($1::text[]) OR
          (p.state IN ('pending','active') AND p.voting_ends_at < now())))
        OR (d.slug = 'aave' AND p.source_type = 'aave_governance_v3' AND p.source_id = '544')
        OR (d.slug = 'lido' AND p.source_type = 'easy_track' AND p.source_id = '1221')
      ORDER BY d.slug, p.source_type, p.source_id
    `, [targets]);
    const { rows: coverage } = await client.query(`
      SELECT d.slug, p.source_type, p.state, count(*) AS total,
             count(*) FILTER (WHERE p.voting_ends_at < now()) AS past_deadline,
             count(*) FILTER (WHERE p.voting_ends_at IS NULL) AS missing_deadline
      FROM proposal p JOIN dao d ON d.id = p.dao_id
      WHERE d.slug IN ('compound','aave','lido')
      GROUP BY d.slug, p.source_type, p.state
      ORDER BY d.slug, p.source_type, p.state
    `);
    const { rows: candidates } = await client.query(`
      WITH ranked AS (
        SELECT d.slug, p.id, p.source_type, p.source_id, p.state, p.state_updated_at,
               p.voting_ends_at, p.voting_ends_block, m.last_reconcile_check_block,
               row_number() OVER (PARTITION BY d.slug, p.source_type
                 ORDER BY p.voting_ends_at ASC NULLS LAST, p.voting_ends_block ASC NULLS LAST) AS rank
        FROM proposal p JOIN dao d ON d.id = p.dao_id
        LEFT JOIN compound_proposal_meta m ON m.proposal_id = p.id
        WHERE d.slug IN ('compound','aave','lido') AND
          ((p.state = 'active' AND (p.voting_ends_at < now() OR p.voting_ends_at IS NULL))
           OR (p.state = 'pending' AND p.voting_ends_at < now()))
      )
      SELECT * FROM ranked WHERE rank <= 20 ORDER BY slug, source_type, rank
    `);
    const { rows: [cursorTable] } = await client.query(`SELECT to_regclass('compound_archive_reconcile_cursor') IS NOT NULL AS present`);
    const archive_audit = cursorTable.present ? (await client.query(`
      SELECT ds.source_type, ds.poll_cursor_block, c.last_checked_block,
             ds.poll_cursor_block - 600 - c.last_checked_block AS blocks_behind_safe_cursor
      FROM dao_source ds LEFT JOIN compound_archive_reconcile_cursor c ON c.dao_source_id = ds.id
      WHERE ds.source_type IN ('compound_governor_alpha','compound_governor_bravo','compound_governor_oz')
      ORDER BY ds.source_type
    `)).rows : null;
    return { sources, proposals, coverage, candidates, archive_audit };
  });
}

// Read the CH archive through its existing HTTP endpoint. Limit the result to
// lifecycle event identity and proposal id; do not export descriptions/calldata.
async function collectArchive() {
  const rows = report.postgres?.proposals?.filter(row => compoundTypes.includes(row.source_type)) || [];
  if (!rows.length) return { events: [], pg_identities: [] };
  const url = new URL(process.env.CLICKHOUSE_URL);
  url.searchParams.set('database', process.env.CLICKHOUSE_DATABASE || 'default');
  url.searchParams.set('readonly', '1');
  url.searchParams.set('max_execution_time', '15');
  url.searchParams.set('param_source_ids', '[' + [...new Set(rows.map(r => r.dao_source_id))]
    .filter(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
    .map(id => "'" + id + "'").join(',') + ']');
  url.searchParams.set('param_proposal_ids', '[' + [...new Set(rows.map(r => r.source_id))]
    .filter(id => /^\d+$/.test(id)).map(id => "'" + id + "'").join(',') + ']');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': process.env.CLICKHOUSE_USER || 'default',
      'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD || '',
    },
    body: `
      SELECT dao_source_id, chain_id, toString(block_number) AS block_number,
             block_hash, tx_hash, log_index, event_type, received_at,
             JSONExtractString(payload, 'proposalId') AS proposal_id
      FROM archive_event_compound_governor_bravo
      WHERE dao_source_id IN {source_ids:Array(UUID)}
        AND event_type IN ('ProposalCreated','ProposalQueued','ProposalExecuted','ProposalCanceled','VoteCast')
        AND JSONExtractString(payload, 'proposalId') IN {proposal_ids:Array(String)}
      ORDER BY block_number, log_index
      LIMIT 2000 FORMAT JSON
    `,
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('ClickHouse request failed');
  const { data: events } = await response.json();
  const pg_identities = await withPg(async (client) => {
    const { rows } = await client.query(`
      SELECT a.dao_source_id, a.source_type, a.chain_id, a.block_number, a.block_hash,
             a.tx_hash, a.log_index, a.event_type, a.received_at, a.derived_at,
             a.derivation_attempt_count, a.derivation_hold_until,
             e.proposal_id
      FROM jsonb_to_recordset($1::jsonb) AS e(
        dao_source_id text, chain_id text, tx_hash text, block_hash text, log_index int, proposal_id text
      )
      LEFT JOIN archive_event a ON a.dao_source_id::text = e.dao_source_id
        AND a.chain_id = e.chain_id AND a.tx_hash = e.tx_hash
        AND a.block_hash = e.block_hash AND a.log_index = e.log_index
      ORDER BY e.proposal_id, a.block_number, a.log_index
    `, [JSON.stringify(events)]);
    return rows;
  });
  return { events, pg_identities, limit: 2000 };
}

// One fixed confirmed head on Ethereum. Bounded, sequential read-only RPC
// calls for the explicit targets; no historical mass scanning.
async function collectChain() {
  const config = JSON.parse(process.env.CHAIN_CONFIG);
  const chain = config.chains.find(item => /^0x[0-9a-f]+$/i.test(item.chainId) && BigInt(item.chainId) === 1n);
  if (!chain) throw new Error('Ethereum config unavailable');
  const providers = chain.providers.filter(provider => provider.kind === 'http')
    .sort((left, right) => left.priority - right.priority);
  let rpcId = 0;
  async function rpc(method, params) {
    for (const provider of providers) {
      try {
        const response = await fetch(provider.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
          signal: AbortSignal.timeout(Math.min(provider.timeoutMs || 8000, 10000)),
        });
        if (!response.ok) continue;
        const result = await response.json();
        if (!result.error && result.result != null) return result.result;
      } catch { /* Do not expose provider configuration or errors. */ }
    }
    throw new Error('All configured HTTP providers failed');
  }
  const head = BigInt(await rpc('eth_blockNumber', []));
  const threshold = head - BigInt(chain.headLag);
  const tag = hex(threshold);
  const block = await rpc('eth_getBlockByNumber', [tag, false]);
  const result = {
    head: head.toString(), head_lag: chain.headLag, confirmed_block: threshold.toString(),
    confirmed_hash: block.hash, confirmed_at: isoTimestamp(block.timestamp), proposals: [],
  };
  // Locate the exact historical transition block by a bounded binary search.
  // This requires archive-state support; a failed read is recorded, never guessed.
  async function historicalState(row, number) {
    const raw = await rpc('eth_call', [{
      to: row.governor_address, data: governor.encodeFunctionData('state', [BigInt(row.source_id)]),
    }, hex(number)]);
    return Number(governor.decodeFunctionResult('state', raw)[0]);
  }
  async function firstMatchingBlock(row, lower, upper, predicate) {
    if (predicate(await historicalState(row, lower))) return lower;
    if (!predicate(await historicalState(row, upper))) throw new Error('Upper bound does not match');
    while (upper - lower > 1n) {
      const mid = (lower + upper) / 2n;
      if (predicate(await historicalState(row, mid))) upper = mid;
      else lower = mid;
    }
    return upper;
  }
  function eventIdentity(log, name) {
    return {
      event_type: name, block_number: BigInt(log.blockNumber).toString(),
      block_hash: log.blockHash, tx_hash: log.transactionHash,
      log_index: Number(BigInt(log.logIndex)),
    };
  }
  function isArchived(row, log) {
    return (report.archive?.events || []).some(event =>
      event.dao_source_id === row.dao_source_id &&
      event.block_hash.toLowerCase() === log.block_hash.toLowerCase() &&
      event.tx_hash.toLowerCase() === log.tx_hash.toLowerCase() &&
      Number(event.log_index) === log.log_index);
  }
  async function collectMissingGovernorEvents(row, code) {
    const evidence = { lifecycle: [], vote_events: null, errors: [] };
    if (row.voting_ends_block == null) return evidence;
    const lower = BigInt(row.voting_ends_block);
    // Only search for event-driven divergence. An executed proposal can pass
    // through queued before execution; confirm both using the actual logs.
    if (code === 7 || code === 5) {
      const transitions = [
        ['ProposalQueued', state => state === 5 || state === 6 || state === 7],
        ...(code === 7 ? [['ProposalExecuted', state => state === 7]] : []),
      ];
      for (const [name, predicate] of transitions) {
        try {
          const number = await firstMatchingBlock(row, lower, threshold, predicate);
          const logs = await rpc('eth_getLogs', [{
            fromBlock: hex(number), toBlock: hex(number), address: row.governor_address,
            topics: [governorEvents.getEvent(name).topicHash],
          }]);
          const matching = [];
          for (const log of logs) {
            const parsed = governorEvents.parseLog(log);
            if (parsed.args[0].toString() !== row.source_id) continue;
            const identity = eventIdentity(log, name);
            matching.push({ ...identity, archived: isArchived(row, identity) });
          }
          evidence.lifecycle.push({ event_type: name, transition_block: number.toString(), matching });
        } catch (error) {
          evidence.errors.push({ event_type: name, code: errorCode(error) });
        }
      }
    }
    // Count source vote events across the exact voting window for OZ proposals
    // with stale active/pending states. Default windows are about 20k blocks.
    // Bounded at 50k blocks; no historical full-chain scans.
    if (row.source_type === 'compound_governor_oz' && row.voting_starts_block != null) {
      try {
        const start = BigInt(row.voting_starts_block);
        if (lower < start || lower - start > 50000n || lower > threshold) throw new Error('Voting window out of bounds');
        const votes = [];
        for (let from = start; from <= lower; from += 2000n) {
          const to = from + 1999n < lower ? from + 1999n : lower;
          const logs = await rpc('eth_getLogs', [{
            fromBlock: hex(from), toBlock: hex(to), address: row.governor_address,
            topics: [governorEvents.getEvent('VoteCast').topicHash],
          }]);
          for (const log of logs) {
            const parsed = governorEvents.parseLog(log);
            if (parsed.args.proposalId.toString() !== row.source_id) continue;
            votes.push(eventIdentity(log, 'VoteCast'));
          }
        }
        evidence.vote_events = {
          onchain_count: votes.length,
          missing_from_ch: votes.filter(log => !isArchived(row, log)),
          // Archive result is capped; an exact comparison requires a complete CH result.
          archive_complete: (report.archive?.events || []).length < (report.archive?.limit || 0),
        };
      } catch (error) { evidence.errors.push({ event_type: 'VoteCast', code: errorCode(error) }); }
    }
    return evidence;
  }
  for (const row of report.postgres?.proposals || []) {
    const item = { slug: row.slug, source_type: row.source_type, source_id: row.source_id };
    try {
      if (row.chain_id !== '0x1') throw new Error('Unsupported chain');
      if (compoundTypes.includes(row.source_type)) {
        const raw = await rpc('eth_call', [{
          to: row.governor_address, data: governor.encodeFunctionData('state', [BigInt(row.source_id)]),
        }, tag]);
        const code = Number(governor.decodeFunctionResult('state', raw)[0]);
        item.raw_state_code = code;
        item.source_state = stateNames[code] || 'unknown';
        if (row.source_type === 'compound_governor_oz') {
          try {
            const deadlineRaw = await rpc('eth_call', [{
              to: row.governor_address,
              data: governorDeadline.encodeFunctionData('proposalDeadline', [BigInt(row.source_id)]),
            }, tag]);
            item.authoritative_deadline_block = governorDeadline.decodeFunctionResult(
              'proposalDeadline', deadlineRaw)[0].toString();
          } catch (error) {
            item.authoritative_deadline_error = errorCode(error);
          }
        }
        if (['pending', 'active'].includes(row.state) && item.source_state !== row.state) {
          item.event_evidence = await collectMissingGovernorEvents(row, code);
        }
      } else if (row.source_type === 'aave_governance_v3') {
        const raw = await rpc('eth_call', [{
          to: row.governance_address, data: aave.encodeFunctionData('getProposalState', [BigInt(row.source_id)]),
        }, tag]);
        item.raw_state_code = Number(aave.decodeFunctionResult('getProposalState', raw)[0]);
      } else if (row.source_type === 'easy_track') {
        const raw = await rpc('eth_call', [{
          to: row.easy_track_address, data: easyTrack.encodeFunctionData('getMotions'),
        }, tag]);
        const motions = easyTrack.decodeFunctionResult('getMotions', raw)[0];
        const motion = motions.find(m => m.id.toString() === row.source_id);
        item.present_in_get_motions = Boolean(motion);
        if (motion) item.objection_window_ends_at = isoTimestamp(motion.startDate + motion.duration);
        // An absent motion alone does not establish executed/canceled/rejected.
      }
      item.deadlines = {};
      for (const key of ['voting_starts_block', 'voting_ends_block']) {
        if (row[key] == null || BigInt(row[key]) > threshold) continue;
        const header = await rpc('eth_getBlockByNumber', [hex(row[key]), false]);
        item.deadlines[key] = { number: row[key], hash: header.hash, timestamp: isoTimestamp(header.timestamp) };
      }
      if (compoundTypes.includes(row.source_type)) {
        const terminalType = item.source_state === 'executed' ? 'ProposalExecuted' :
          item.source_state === 'canceled' ? 'ProposalCanceled' : null;
        const terminal = (report.archive?.events || []).find(event =>
          event.dao_source_id === row.dao_source_id && event.proposal_id === row.source_id &&
          event.event_type === terminalType);
        if (terminal) {
          const header = await rpc('eth_getBlockByNumber', [hex(terminal.block_number), false]);
          item.terminal_event = {
            type: terminalType, block_number: terminal.block_number,
            timestamp: isoTimestamp(header.timestamp),
            canonical: header.hash.toLowerCase() === terminal.block_hash.toLowerCase(),
          };
        }
      }
    } catch (error) { item.error = errorCode(error); }
    result.proposals.push(item);
  }
  const endBlock = await rpc('eth_getBlockByNumber', [tag, false]);
  result.reference_hash_unchanged = endBlock.hash === block.hash;
  return result;
}

async function collectApi() {
  const base = process.env.BACKEND_API_URL || 'http://kvorum-api.kvorum';
  const headers = process.env.INTERNAL_READ_TOKEN
    ? { 'x-internal-read-token': process.env.INTERNAL_READ_TOKEN } : {};
  const paths = [
    '/v1/proposals?state=active&sort=voting_ends_at&limit=100',
    '/v1/daos/compound/proposals?sort=-voting_ends_at&limit=30',
    ...targets.map(id => '/v1/daos/compound/proposals/compound_governor_oz/' + id),
    ...targets.map(id => '/v1/daos/compound/proposals/compound_governor_oz/' + id + '/tally'),
    '/v1/daos/lido/proposals/easy_track/1221',
    '/v1/daos/aave/proposals/aave_governance_v3/544',
  ];
  const results = [];
  for (const path of paths) {
    const entry = { path, observed_at: new Date().toISOString() };
    try {
      const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) });
      entry.status = response.status;
      entry.etag = response.headers.get('etag');
      entry.cache_control = response.headers.get('cache-control');
      entry.age = response.headers.get('age');
      if (response.ok) {
        const json = await response.json();
        if (path.endsWith('/tally')) {
          entry.tally = json.data;
          results.push(entry);
          continue;
        }
        const data = Array.isArray(json.data) ? json.data : [json.data];
        entry.proposals = data.filter(Boolean).map(row => ({
          dao_slug: row.dao_slug, source_type: row.source_type, source_id: row.source_id,
          state: row.state, state_updated_at: row.state_updated_at,
          voting_starts_at: row.voting_starts_at, voting_ends_at: row.voting_ends_at,
        }));
        entry.has_next_cursor = Boolean(json.pagination?.next_cursor);
      }
    } catch (error) { entry.error = errorCode(error); }
    results.push(entry);
  }
  return results;
}

async function collectChainIdentities() {
  const rows = [];
  for (const proposal of report.chain?.proposals || []) {
    const evidence = proposal.event_evidence;
    if (!evidence) continue;
    const source = report.postgres.proposals.find(row =>
      row.slug === proposal.slug && row.source_type === proposal.source_type &&
      row.source_id === proposal.source_id);
    const events = [
      ...evidence.lifecycle.flatMap(transition => transition.matching),
      ...(evidence.vote_events?.missing_from_ch || []),
    ];
    for (const event of events) rows.push({ ...event, source_id: source.source_id,
      dao_source_id: source.dao_source_id, chain_id: source.chain_id });
  }
  if (!rows.length) return [];
  return withPg(async (client) => {
    const result = await client.query(`
      SELECT e.source_id, e.event_type, e.block_number AS source_block,
             e.tx_hash, e.block_hash, e.log_index,
             a.id AS archive_id, a.derived_at, a.derivation_attempt_count,
             a.derivation_hold_until
      FROM jsonb_to_recordset($1::jsonb) AS e(
        source_id text, event_type text, block_number text, dao_source_id text,
        chain_id text, tx_hash text, block_hash text, log_index int
      )
      LEFT JOIN archive_event a ON a.dao_source_id::text = e.dao_source_id
        AND a.chain_id = e.chain_id AND a.tx_hash = e.tx_hash
        AND a.block_hash = e.block_hash AND a.log_index = e.log_index
      ORDER BY e.source_id, e.block_number, e.log_index
    `, [JSON.stringify(rows)]);
    return result.rows;
  });
}

async function collectMetrics() {
  const response = await fetch('http://localhost:' + (process.env.OPS_PORT || '9091') + '/metrics', {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Metrics unavailable');
  const metrics = (await response.text()).split('\n');
  return metrics.filter(line => /^(?:kvorum_)?(?:indexer_state_reconcile|indexer_compound_archive_audit|indexer_derivation_lag|indexer_timestamp_fill|ingestion_log_poll_lag)[a-z0-9_]*(?:\{| )/.test(line));
}

(async () => {
  await section('postgres', collectPg);
  await section('archive', collectArchive);
  await section('chain', collectChain);
  await section('chain_archive_identities', collectChainIdentities);
  await section('api', collectApi);
  await section('metrics', collectMetrics);
  report.finished_at = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
})().catch(() => { console.error('Diagnostic collection failed'); process.exitCode = 1; });
NODE

# Keep only structured outcome metadata from a bounded recent log window.
# Do not save raw log lines (they may include credentials or provider URLs).
if ! kubectl -n "$namespace" logs "$indexer" -c indexer --since=48h --tail=10000 |
  node -e '
    const readline = require("node:readline");
    const events = new Set(["state_reconcile_missed_event","state_reconcile_decode_error",
      "state_reconcile_rpc_escalated","derivation_ch_missing","derivation_decode_failed",
      "derivation_pg_tx_failed","timestamp_fill_rpc_failed","compound_archive_audit_failed","compound_archive_repaired",
      "compound_archive_repair_started","compound_archive_event_repaired","compound_archive_repair_failed",
      "compound_deadline_reconciled","compound_state_reconciled","compound_eligible_voting_power_reconciled"]);
    const keys = ["source_type","source_id","local_state","onchain_state","outcome",
      "chain_id","block","streak","attempt","row_id","event_type","tx_hash","log_index","block_hash","from_block","to_block","repaired",
      "dao_source_id","governor_address","proposal_id","missing_store","voter","choice","voting_power","proposer","start_block","end_block","eta",
      "previous_deadline_block","deadline_block","deadline_at","from_state","to_state","state_updated_at","eligible_voting_power"];
    const rl = readline.createInterface({input:process.stdin});
    rl.on("line", line => {
      try {
        const row = JSON.parse(line);
        const fields = row.message && typeof row.message === "object" ? row.message : row;
        const name = fields.event || row.msg || row.message;
        if (!events.has(name)) return;
        const result = { event:name, time:row.time || row.timestamp };
        for (const key of keys) {
          const value = fields[key];
          if (value === null || typeof value === "number" || (typeof value === "string" && /^[a-zA-Z0-9_.:+-]{1,100}$/.test(value))) result[key] = value;
        }
        console.log(JSON.stringify(result));
      } catch {}
    });
  ' > "$output_dir/reconcile-logs.jsonl"; then
  echo "Log collection failed or incomplete; report.json is still available." >&2
fi

echo "Done: $output_dir" >&2
echo "Return report.json and reconcile-logs.jsonl (empty log file is okay)." >&2
