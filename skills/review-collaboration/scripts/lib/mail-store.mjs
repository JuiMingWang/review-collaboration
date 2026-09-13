// Persistent mail records on disk.
//
// Rules this module exists to keep:
//   - an archived letter is written once and never rewritten;
//   - anything mutable is written to a temporary file in the same directory and
//     renamed over the old one, so a reader never sees a half written record;
//   - a completion is published last, in one step, and only describes evidence
//     that is on disk and still hashes to what the record claims;
//   - one run is served by one process at a time, and any lock is released only
//     by its owner or by recovery that proved the owner is gone;
//   - one evaluator answers "does this exchange still hold together", so the
//     first completion, a repeated completion and recovery can never disagree
//     about the same damage.
//
// Fault injection for tests is a list of stage names carried in an options
// object. It is data, not code, and nothing in the JSON request envelope can
// reach it: only a caller inside this package can pass it.

import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync as rawReaddirSync,
  readFileSync as rawReadFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, normalize } from 'node:path';

import {
  COMPLETION_STATUSES,
  DELIVERY_VALUES,
  EXCHANGE_FILES,
  RECORD_DIR_NAME,
  SCHEMA_VERSION,
  StoreError,
  assertInputDraft,
  assertRouteSnapshot,
  assertSafeRelative,
  assertSelection,
  assertUuid,
  buildCompletion,
  buildInput,
  buildOutboundDocument,
  classifyOutcome,
  completionShapeProblems,
  decodeUtf8Strict,
  exchangeDirOf,
  exchangesDir,
  fail,
  gitignoreFile,
  indexFile,
  indexLockFile,
  jsonBytes,
  newUuid,
  projectFile,
  recordRootFor,
  runDir as runDirOf,
  runFile,
  runLockFile,
  runsDir,
  sha256Hex,
  savedResultProblems,
  resultFromSaved,
  transportProblems,
  fullTransportProblems,
  topicDir,
  topicFile,
  topicLockFile,
  topicsDir,
} from './mail-contract.mjs';

export { StoreError };
import { mutateLock } from './windows-lock.mjs';
import { safePath, ensurePrivateIgnore } from './safe-files.mjs';
const readFileSync=(path,...options)=>rawReadFileSync(safePath(path,{file:true}),...options);
const readdirSync=(path,...options)=>rawReaddirSync(safePath(path),...options);

// Operational defaults from the plan. They are program timings, not review
// rules, and a single run may record different ones.
export const DEFAULT_TIMEOUTS = {
  prompt_deadline_ms: 600000,
  cancel_grace_ms: 10000,
  outer_hard_timeout_ms: 615000,
};

const SHORT_LOCK_WAIT_MS = 5000;
const SHORT_LOCK_RETRY_MS = 15;
// Asking the operating system about a process costs a child process, so a
// waiting caller asks a few times rather than on every retry.
const LIVENESS_RECHECK_MS = 500;
const IDENTITY_QUERY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Fault injection (tests only)
// ---------------------------------------------------------------------------

function faultGate(options) {
  const points = new Set(Array.isArray(options?.faultPoints) ? options.faultPoints : []);
  const gate = (stage) => {
    if (points.has(stage)) fail('store-fault-injected', `forced failure at save stage ${stage}`);
  };
  gate.armed = (stage) => points.has(stage);
  return gate;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** An archived artifact: created exclusively, flushed, and never rewritten. */
function writeNewFile(path, bytes, what) {
  safePath(path, { file: true });
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') fail('already-archived', `${what} is already archived and is never rewritten: ${path}`);
    throw error;
  }
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A mutable record: written beside the target, flushed, then renamed over it. */
function writeMutableFile(path, bytes) {
  safePath(path, { file: true });
  const tmp = `${path}.${newUuid()}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Publishes a document that must appear whole or not at all, and must never
 * replace one that is already there.
 *
 * The bytes are written and flushed to a temporary name first, so a failure
 * during writing leaves a leftover temporary file and nothing under the real
 * name. Publication is then a hard link, which fails if the name is taken; on
 * a file system without hard links fails without replacing any published file.
 */
function publishFileAtomically(path, bytes, what, gate, faultStage) {
  safePath(path, { file: true });
  const tmp = `${path}.${newUuid()}.tmp`;
  const short = typeof gate?.armed === 'function' && faultStage ? gate.armed(faultStage) : false;
  const fd = openSync(tmp, 'wx');
  try {
    writeFileSync(fd, short ? bytes.subarray(0, Math.min(9, bytes.length)) : bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (short) fail('store-fault-injected', `forced failure while writing ${what}`, [tmp]);

  try {
    linkSync(tmp, path);
  } catch (error) {
    if (error.code === 'EEXIST') fail('already-archived', `${what} is already published and is never replaced: ${path}`);
    if (['EPERM', 'ENOSYS', 'EXDEV', 'EINVAL', 'ENOTSUP'].includes(error.code)) {
      fail('atomic-publication-unsupported', `cannot exclusively publish ${what}: ${error.code}`, [tmp]);
    }
    throw error;
  }
  // Publication has already succeeded; leftover temp cleanup cannot revoke it.
  try { rmSync(tmp, { force: true }); } catch { /* recover can still verify the published record */ }
}

function readJsonFile(path, what) {
  safePath(path, { file: true });
  let text;
  try {
    text = decodeUtf8Strict(readFileSync(path), what);
  } catch (error) {
    if (error.code === 'ENOENT') fail('record-missing', `${what} is missing: ${path}`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail('record-unreadable', `${what} is not readable JSON: ${path}`);
  }
}

const hasField = (object, field) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, field);

// ---------------------------------------------------------------------------
// Write permission for a record root
// ---------------------------------------------------------------------------

function assertWritableDirectory(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch {
    fail('record-root-unavailable', `${dir} is not writable; choose an explicit record location instead`);
  }
}

/**
 * Whether the record folder sits inside a Git repository, and whether it is
 * already tracked there. When the answer cannot be established the caller is
 * told so rather than guessed at: writing private records into a tracked
 * folder is not something to get wrong quietly.
 */
function gitTrackingState(projectRoot, options) {
  if (typeof options?.gitProbe === 'function') return options.gitProbe(projectRoot);

  let dir = projectRoot;
  let inRepository = false;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      inRepository = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!inRepository) return { repository: false, tracked: false };

  const probe = spawnSync('git', ['-C', projectRoot, 'ls-files', '--', RECORD_DIR_NAME], {
    encoding: 'utf8',
    timeout: IDENTITY_QUERY_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (probe.error || probe.status !== 0) return { repository: true, tracked: null };
  return { repository: true, tracked: probe.stdout.trim().length > 0 };
}

/**
 * The check that has to pass before any private content is added to a record
 * root, wherever the write comes from.
 *
 * Opening records that already exist is still opening them for writing, so
 * this does not become optional once a project has been created. Reading what
 * is already archived does not call it. Each top-level write checks once;
 * this result is not cached across separate operations in the same process.
 */
export function ensureRecordRootWritable(recordRoot, options = {}) {
  safePath(recordRoot);
  const projectRoot = dirname(recordRoot);
  if (!existsSync(projectRoot)) fail('record-root-unavailable', `project root does not exist: ${projectRoot}`);
  assertWritableDirectory(projectRoot);
  if (existsSync(recordRoot)) assertWritableDirectory(recordRoot);

  const git = gitTrackingState(projectRoot, options);
  if (git.tracked === null) {
    fail('git-status-unknown', `${projectRoot} is inside a Git repository but its tracking state could not be read`);
  }
  if (git.tracked === true) {
    fail('record-root-git-tracked', `${RECORD_DIR_NAME} is tracked by Git; private records are not written there`);
  }
  if(existsSync(recordRoot))ensurePrivateIgnore(recordRoot);

  return { checked: true, remembered: false };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/**
 * Creates or reopens the private record folder for one project.
 *
 * The project id is random: two folders with the same name are two different
 * projects, and moving a folder does not change which project it is.
 */
export async function initProject(projectRoot, options = {}) {
  const recordRoot = recordRootFor(projectRoot);
  ensureRecordRootWritable(recordRoot, { ...options, forceRecheck: true });

  const manifest = projectFile(recordRoot);
  if (existsSync(manifest)) {
    const existing = readJsonFile(manifest, 'project.json');
    assertUuid(existing.project_id, 'project.json project_id');
    return { project_id: existing.project_id, record_root: recordRoot, created: false };
  }

  mkdirSync(recordRoot, { recursive: true });
  mkdirSync(topicsDir(recordRoot), { recursive: true });
  if (!existsSync(gitignoreFile(recordRoot))) writeNewFile(gitignoreFile(recordRoot), Buffer.from('*\n', 'utf8'), '.gitignore');

  const projectId = newUuid();
  writeNewFile(
    manifest,
    jsonBytes({ schema_version: SCHEMA_VERSION, project_id: projectId, created_at: new Date().toISOString() }),
    'project.json',
  );
  await rebuildIndex(recordRoot);
  return { project_id: projectId, record_root: recordRoot, created: true };
}

export function readProject(recordRoot) {
  return readJsonFile(projectFile(recordRoot), 'project.json');
}

// ---------------------------------------------------------------------------
// Process identity and locks
// ---------------------------------------------------------------------------

let cachedOwnStartTime;

/**
 * Asks Windows when a process started.
 *
 * A process id alone is not an identity: ids are reused. Pairing the id with
 * the start time the operating system reports is what makes "is the owner of
 * this lock still alive" answerable. When the question cannot be answered the
 * result says so, and the caller must stay conservative.
 */
function queryProcessStart(pid) {
  if(!Number.isInteger(pid)||pid<=0)return {state:'unknown',start_time_ms:null,detail:'invalid-owner-pid'};
  const script =
    "$ErrorActionPreference='SilentlyContinue';"
    + `$p = Get-Process -Id ${Number(pid)};`
    + "if ($null -eq $p) { 'not-found' } else { $t = $p.StartTime; if ($null -eq $t) { 'unknown' } else { [DateTimeOffset]::new($t).ToUnixTimeMilliseconds() } }";
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: IDENTITY_QUERY_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (probe.error || probe.status !== 0) return { state: 'unknown', start_time_ms: null, detail: 'identity-query-failed' };
  const text = (probe.stdout ?? '').trim();
  if (text === 'not-found') return { state: 'not-found', start_time_ms: null, detail: null };
  if (/^\d+$/.test(text)) return { state: 'alive', start_time_ms: Number(text), detail: null };
  return { state: 'unknown', start_time_ms: null, detail: `unexpected-identity-output:${text.slice(0, 40)}` };
}

function ownStartTime() {
  if (cachedOwnStartTime === undefined) {
    const probe = queryProcessStart(process.pid);
    cachedOwnStartTime = probe.state === 'alive' ? probe.start_time_ms : null;
  }
  return cachedOwnStartTime;
}

function ownIdentity() {
  return {
    schema_version: SCHEMA_VERSION,
    owner_nonce: newUuid(),
    pid: process.pid,
    process_start_time_ms: ownStartTime(),
    host: hostname(),
    acquired_at: new Date().toISOString(),
  };
}

/**
 * Decides whether the process named in a lock is still the process that took
 * it. true means alive, false means provably gone, null means the question
 * could not be answered and nothing may be reclaimed.
 */
export function ownerLiveness(owner, options = {}) {
  const probe = typeof options.identityProbe === 'function' ? options.identityProbe(owner.pid) : queryProcessStart(owner.pid);
  if (probe.state === 'not-found') return { alive: false, reason: 'owner-process-not-found', probe };
  if (probe.state !== 'alive') return { alive: null, reason: 'owner-identity-unknown', probe };
  if (owner.process_start_time_ms === null || owner.process_start_time_ms === undefined) {
    return { alive: null, reason: 'lock-has-no-start-time', probe };
  }
  if (probe.start_time_ms !== owner.process_start_time_ms) {
    return { alive: false, reason: 'owner-pid-reused', probe };
  }
  return { alive: true, reason: 'owner-alive', probe };
}

/**
 * Reads a lock record, or null when there is nothing readable there.
 *
 * A lock is created exclusively and filled in immediately afterwards, so a
 * competing process can catch it in the instant between the two and see an
 * empty file. That is an unknown owner, not a corrupt record, and the caller
 * stays conservative either way.
 */
function readLock(path) {
  try {
    return readJsonFile(path, 'lock');
  } catch (error) {
    if (['record-missing', 'record-unreadable', 'invalid-utf8'].includes(error.code)) return null;
    throw error;
  }
}

/**
 * Clears a lock only when its owner is provably a process that no longer
 * exists, and only if the lock is still the very one that was examined.
 */
function reclaimIfOwnerGone(path, options = {}) {
  const owner = readLock(path);
  if (owner === null) return { released: false, reason: 'lock-unreadable', owner: null, liveness: null };

  const liveness = ownerLiveness(owner, options);
  if (liveness.alive === true) return { released: false, reason: 'lock-owner-alive', owner, liveness };
  if (liveness.alive === null) return { released: false, reason: 'lock-owner-unknown', owner, liveness };

  const removal = deleteLockIfOwner(path, owner.owner_nonce);
  if (removal.result !== 'deleted') {
    return { released: false, reason: 'lock-changed-during-recovery', owner, liveness };
  }
  return { released: true, reason: liveness.reason, owner, liveness };
}

/** Removes a lock only if it is still the one this owner wrote. */
export function releaseStoreLock(path, ownerNonce) {
  const removal = deleteLockIfOwner(path, ownerNonce);
  if (removal.result === 'absent') return { released: false, reason: 'lock-already-gone' };
  if (removal.result !== 'deleted') {
    fail('lock-ownership-changed', `the lock at ${path} was not removed: ${removal.result}`);
  }
  return { released: true, reason: 'released-by-owner' };
}

export function deleteLockIfOwner(path, ownerNonce, testOptions = {}) {
  return mutateLock(path, 'delete', { expected_nonce: ownerNonce }, testOptions);
}

/** Kept under its original name for the run lock. */
export const releaseRunLock = releaseStoreLock;

/**
 * Takes a short lock, waiting a bounded time for whoever holds it.
 *
 * While waiting it asks the operating system, now and then, whether the holder
 * is still a live process. A holder that is provably gone has its lock cleared
 * and the wait continues; a live holder, or one whose identity cannot be read,
 * keeps it. Elapsed time on its own is never treated as death.
 */
function acquireShortLock(path, label, options = {}) {
  const waitMs = options.lockWaitMs ?? SHORT_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let nextLivenessCheck = Date.now() + LIVENESS_RECHECK_MS;

  for (;;) {
    const identity = { ...ownIdentity(), lock: label };
    if (mutateLock(path, 'create', { owner: identity }).result === 'created') {
      return {
        path,
        owner_nonce: identity.owner_nonce,
        release: () => releaseStoreLock(path, identity.owner_nonce),
      };
    }

    if (Date.now() >= nextLivenessCheck) {
      nextLivenessCheck = Date.now() + LIVENESS_RECHECK_MS;
      if (reclaimIfOwnerGone(path, options).released) continue;
    }

    if (Date.now() >= deadline) {
      const owner = readLock(path);
      fail(
        `${label}-busy`,
        `the ${label} lock stayed held for ${waitMs} ms by pid ${owner?.pid ?? 'unknown'}`,
        [path],
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SHORT_LOCK_RETRY_MS);
  }
}

/**
 * Takes one of the store's short locks by name. Exposed so a caller in this
 * package, including a test that needs a lock held by a separate process, uses
 * the same primitive the store uses rather than writing a lock file by hand.
 */
export async function acquireStoreLock(recordRoot, kind, options = {}) {
  if (kind === 'index') return acquireShortLock(indexLockFile(recordRoot), 'index', options);
  if (kind === 'topic') return acquireShortLock(topicLockFile(recordRoot, options.topicId), 'topic', options);
  return fail('invalid-lock-kind', `no store lock named ${JSON.stringify(kind)}`);
}

// Package-local profile records use the same owner-aware short lock primitive.
export function acquireMetadataLock(path, label = 'profile') {
  return acquireShortLock(path, label);
}

/**
 * Looks at every lock in these records and clears only those whose owner is
 * provably gone.
 *
 * Covers the short topic and index locks as well as run locks: a short lock
 * left behind by a process that died is exactly as stuck as a run lock, and
 * before this it had no way back.
 */
export async function recoverStoreLocks(recordRoot, options = {}) {
  const found = [];
  const consider = (kind, path, extra = {}) => {
    if (!existsSync(path)) return;
    const decision = reclaimIfOwnerGone(path, options);
    found.push({
      kind,
      path,
      ...extra,
      lock_present: true,
      released: decision.released,
      reason: decision.reason,
      owner: decision.owner,
    });
  };

  consider('index', indexLockFile(recordRoot));

  const topics = topicsDir(recordRoot);
  if (existsSync(topics)) {
    for (const topicId of readdirSync(topics)) {
      const topicPath = join(topics, topicId);
      consider('topic', join(topicPath, 'topic.lock'), { topic_id: topicId });
      const runs = join(topicPath, 'runs');
      if (!existsSync(runs)) continue;
      for (const runId of readdirSync(runs)) {
        consider('run', join(runs, runId, 'run.lock'), { topic_id: topicId, run_id: runId });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

export async function createTopic(recordRoot, options = {}) {
  const { title, related_topic_ids = [] } = options;
  if (typeof title !== 'string' || title.trim().length === 0) fail('invalid-topic', 'topic title must be a non-empty string');
  if (!Array.isArray(related_topic_ids)) fail('invalid-topic', 'related_topic_ids must be an array');
  for (const id of related_topic_ids) assertUuid(id, 'related_topic_ids entry');
  ensureRecordRootWritable(recordRoot, options);
  readProject(recordRoot);

  const topicId = newUuid();
  const dir = topicDir(recordRoot, topicId);
  mkdirSync(dir, { recursive: false });
  mkdirSync(runsDir(recordRoot, topicId), { recursive: false });
  writeNewFile(
    topicFile(recordRoot, topicId),
    jsonBytes({
      schema_version: SCHEMA_VERSION,
      topic_id: topicId,
      title,
      revision: 1,
      related_topic_ids: [...related_topic_ids],
      created_at: new Date().toISOString(),
    }),
    'topic.json',
  );

  await rebuildIndex(recordRoot);
  return { topic_id: topicId, revision: 1, relative_path: `topics/${topicId}` };
}

export function readTopic(recordRoot, topicId) {
  return readJsonFile(topicFile(recordRoot, topicId), 'topic.json');
}

/**
 * Raises the topic revision, one step at a time.
 *
 * The read, the comparison and the write all happen while holding the topic's
 * own short lock, and the value compared is read fresh inside that lock.
 * Renaming a file into place is not enough on its own: two processes that both
 * read revision 1 would both write revision 2 and one change would vanish.
 * This version is what decides whether a reply still applies to the premise it
 * was written against, so a silently merged update is not acceptable.
 *
 * Only a change of premise calls this. An ordinary handoff or adoption note
 * leaves the revision alone.
 */
export async function bumpTopicRevision(recordRoot, topicId, expectedRevision, options = {}) {
  ensureRecordRootWritable(recordRoot, options);
  const lock = acquireShortLock(topicLockFile(recordRoot, topicId), 'topic', options);
  let next;
  try {
    const topic = readTopic(recordRoot, topicId);
    if (topic.revision !== expectedRevision) {
      fail('topic-revision-mismatch', `topic ${topicId} is at revision ${topic.revision}, not ${expectedRevision}`);
    }
    next = topic.revision + 1;
    writeMutableFile(topicFile(recordRoot, topicId), jsonBytes({ ...topic, revision: next, updated_at: new Date().toISOString() }));
  } finally {
    lock.release();
  }
  await rebuildIndex(recordRoot);
  return next;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const INDEX_HEADER = [
  '# Topic index',
  '',
  '<!-- Rebuilt by the store from each topics/<topic_id>/topic.json. Not edited by hand. -->',
  '',
  '| topic_id | revision | relative_path | title |',
  '| --- | --- | --- | --- |',
];

const escapeCell = (value) => String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/**
 * Rebuilds the index from each topic's own metadata.
 *
 * The index is a convenience, never the source of truth: losing it or finding
 * it corrupted costs nothing, because it is regenerated from the topic files
 * that hold the letters.
 */
export async function rebuildIndex(recordRoot, options = {}) {
  const lock = acquireShortLock(indexLockFile(recordRoot), 'index', options);
  try {
    const dir = topicsDir(recordRoot);
    const entries = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const manifest = join(dir, name, 'topic.json');
        if (!existsSync(manifest)) continue;
        let topic;
        try {
          topic = readJsonFile(manifest, 'topic.json');
        } catch {
          continue;
        }
        if (typeof topic?.topic_id !== 'string' || topic.topic_id !== name) continue;
        entries.push({ topic_id: topic.topic_id, revision: topic.revision, relative_path: `topics/${topic.topic_id}`, title: topic.title });
      }
    }
    entries.sort((a, b) => a.topic_id.localeCompare(b.topic_id));
    const lines = [
      ...INDEX_HEADER,
      ...entries.map((e) => `| ${e.topic_id} | ${e.revision} | ${e.relative_path} | ${escapeCell(e.title)} |`),
      '',
    ];
    writeMutableFile(indexFile(recordRoot), Buffer.from(lines.join('\n'), 'utf8'));
    return entries;
  } finally {
    lock.release();
  }
}

export function readIndex(recordRoot) {
  const path = indexFile(recordRoot);
  if (!existsSync(path)) return null;
  const text = decodeUtf8Strict(readFileSync(path), 'index.md');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*([0-9a-f-]{36})\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|$/.exec(line);
    if (!match) continue;
    entries.push({ topic_id: match[1], revision: Number(match[2]), relative_path: match[3], title: match[4] });
  }
  return entries;
}

/**
 * Finds where a topic lives from its id alone, so a new host with nothing but
 * the id can open the letters. The answer is a path relative to the record
 * root, never an absolute path recorded on the machine that wrote it.
 */
export async function locateTopic(recordRoot, topicId) {
  assertUuid(topicId, 'topic_id');
  let entries = readIndex(recordRoot);
  let entry = entries?.find((e) => e.topic_id === topicId);
  if (!entry) {
    entries = await rebuildIndex(recordRoot);
    entry = entries.find((e) => e.topic_id === topicId);
  }
  if (!entry) fail('topic-not-found', `no topic ${topicId} in ${recordRoot}`);
  assertSafeRelative(entry.relative_path, 'index relative_path');
  return entry;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Opens a run: one skill invocation, holding a frozen copy of the selection and
 * route in use at this moment. A later profile change does not reach back into
 * a run that is already open.
 */
export async function openRun(recordRoot, options = {}) {
  const { topic_id, host_id, host_session_key, selection, route, timeouts } = options;
  assertUuid(topic_id, 'topic_id');
  if (!existsSync(topicFile(recordRoot, topic_id))) fail('topic-not-found', `no topic ${topic_id} in ${recordRoot}`);
  if (typeof host_id !== 'string' || host_id.length === 0) fail('invalid-run', 'host_id must be a non-empty string');
  if (typeof host_session_key !== 'string' || host_session_key.length === 0) {
    fail('invalid-run', 'host_session_key must be a non-empty string');
  }
  assertSelection(selection);
  assertRouteSnapshot(route);
  if (selection.route_id !== route.route_id) fail('invalid-run', 'selection.route_id must match the route snapshot');
  ensureRecordRootWritable(recordRoot, options);

  const project = readProject(recordRoot);
  const runId = newUuid();
  const dir = runDirOf(recordRoot, topic_id, runId);
  mkdirSync(dir, { recursive: false });
  mkdirSync(exchangesDir(recordRoot, topic_id, runId), { recursive: false });

  writeNewFile(
    runFile(recordRoot, topic_id, runId),
    jsonBytes({
      schema_version: SCHEMA_VERSION,
      project_id: project.project_id,
      topic_id,
      run_id: runId,
      host_id,
      // Either a native identifier or a stable nonce the host made for this
      // session. Which one it is stays recorded; it is not passed off as a
      // provider-issued id.
      host_session_key,
      host_session_key_source: 'caller-supplied',
      selection,
      route,
      timeouts: { ...DEFAULT_TIMEOUTS, ...(timeouts ?? {}) },
      opened_at: new Date().toISOString(),
    }),
    'run.json',
  );

  return { run_id: runId, topic_id, run_dir: dir, relative_path: `topics/${topic_id}/runs/${runId}` };
}

/**
 * Finds which topic a run belongs to by looking at the records themselves.
 *
 * Deliberately a scan rather than a pointer file: a "latest run" pointer is the
 * kind of shortcut that pairs a reply with the wrong letter.
 */
export function locateRun(recordRoot, runId) {
  assertUuid(runId, 'run_id');
  const dir = topicsDir(recordRoot);
  safePath(dir);
  if (!existsSync(dir)) fail('run-not-found', `no run ${runId} in ${recordRoot}`);
  for (const name of readdirSync(dir)) {
    const candidate = join(dir, name, 'runs', runId, 'run.json');
    safePath(candidate,{file:true});
    if (existsSync(candidate)) {
      const run = readJsonFile(candidate, 'run.json');
      if (run.run_id !== runId || run.topic_id !== name) fail('record-inconsistent', `run.json at ${candidate} disagrees with its location`);
      return { topic_id: name, run_id: runId, run_dir: dirname(candidate), run };
    }
  }
  return fail('run-not-found', `no run ${runId} in ${recordRoot}`);
}

export function readRun(recordRoot, runId) {
  return locateRun(recordRoot, runId).run;
}

/**
 * Runs one piece of work while holding the run's lock.
 *
 * A lock that is already held is reported as run-busy; nothing the waiting
 * caller has already archived is touched. A stale lock is not reclaimed here:
 * only recovery, which checks the owner's identity, may remove one.
 */
export async function withRunLock(recordRoot, runId, callback, options = {}) {
  const located = locateRun(recordRoot, runId);
  const path = runLockFile(recordRoot, located.topic_id, runId);
  const identity = { ...ownIdentity(), run_id: runId, lock: 'run' };

  if (mutateLock(path, 'create', { owner: identity }).result !== 'created') {
    const owner = readLock(path);
    const liveness = owner ? ownerLiveness(owner, options) : { reason: 'lock-unreadable' };
    throw new StoreError(
      'run-busy',
      `run ${runId} is held by pid ${owner?.pid ?? 'unknown'} (${liveness.reason}); nothing already archived was changed`,
      [path],
    );
  }
  try {
    return await callback({ lockPath: path, owner_nonce: identity.owner_nonce });
  } finally {
    releaseStoreLock(path, identity.owner_nonce);
  }
}

/**
 * Inspects a run's lock and clears it only when the owner is provably gone.
 *
 * Age is not evidence: a lock held by a live process stays, however long the
 * reviewer takes. No model is called and nothing is resent.
 */
export async function recoverRun(recordRoot, runId, options = {}) {
  const located = locateRun(recordRoot, runId);
  const path = runLockFile(recordRoot, located.topic_id, runId);
  if (!existsSync(path)) return { lock_present: false, released: false, reason: 'no-lock', owner: null };
  const decision = reclaimIfOwnerGone(path, options);
  return { lock_present: true, ...decision };
}

// ---------------------------------------------------------------------------
// Exchange evidence
// ---------------------------------------------------------------------------

/**
 * Everything the disk can be made to say about one exchange, checked against
 * itself.
 *
 * The first completion, a repeated completion, a repeated delivery draft and
 * recovery all go through this, so they cannot reach different verdicts about
 * the same damage. Information that is absent is a problem to report, never a
 * check that quietly stops running: a record whose own hash fields were
 * deleted is less trustworthy than one that has them, not more.
 */
export function evaluateExchangeEvidence(exchangeDir) {
  safePath(exchangeDir);
  const problems = [];
  const evidenceRefs = [];
  const seen = (file) => {
    const path = join(exchangeDir, file);
    safePath(path,{file:true,within:exchangeDir});
    if (!existsSync(path)) return null;
    evidenceRefs.push(file);
    return path;
  };

  const statePath = seen(EXCHANGE_FILES.state);
  if (statePath === null) {
    for (const file of [EXCHANGE_FILES.request, EXCHANGE_FILES.input, EXCHANGE_FILES.outbound]) seen(file);
    return {
      state: null,
      input: null,
      agentResult: null,
      completion: null,
      hashes: { request: null, outbound: null, input: null, reply: null },
      problems: ['archive-incomplete'],
      evidence_refs: evidenceRefs,
      stage: 'archive-incomplete',
    };
  }

  let state = null;
  try {
    state = readJsonFile(statePath, 'state.json');
  } catch (error) {
    problems.push(`state-${error.code ?? 'unreadable'}`);
  }

  const hashOf = (file, label) => {
    const path = seen(file);
    if (path === null) return null;
    try {
      return sha256Hex(readFileSync(path));
    } catch {
      problems.push(`${label}-unreadable`);
      return null;
    }
  };

  const hashes = {
    request: hashOf(EXCHANGE_FILES.request, 'request'),
    outbound: hashOf(EXCHANGE_FILES.outbound, 'outbound'),
    input: hashOf(EXCHANGE_FILES.input, 'input'),
    reply: hashOf(EXCHANGE_FILES.reply, 'reply'),
  };
  if (existsSync(join(exchangeDir, EXCHANGE_FILES.replyPartial))) evidenceRefs.push(EXCHANGE_FILES.replyPartial);

  for (const [file, key] of [[EXCHANGE_FILES.request, 'request'], [EXCHANGE_FILES.outbound, 'outbound'], [EXCHANGE_FILES.input, 'input']]) {
    if (hashes[key] === null) problems.push(`${key}-missing`);
    else void file;
  }

  if (state !== null) {
    for (const [field, key] of [['request_sha256', 'request'], ['outbound_sha256', 'outbound'], ['input_sha256', 'input']]) {
      if (!hasField(state, field) || typeof state[field] !== 'string') problems.push(`state.missing-${field}`);
      else if (hashes[key] !== null && state[field] !== hashes[key]) problems.push(`${key}-hash-mismatch`);
    }
    if (typeof state.reply_sha256 === 'string' && state.reply_sha256 !== hashes.reply) problems.push('reply-hash-mismatch');
  }

  let input = null;
  if (hashes.input !== null) {
    try {
      input = readJsonFile(join(exchangeDir, EXCHANGE_FILES.input), 'input.json');
    } catch (error) {
      problems.push(`input-${error.code ?? 'unreadable'}`);
    }
  }

  if (input !== null) {
    try { assertInputDraft(input); } catch (error) { problems.push(`input-${error.code}`); }
    if (input.request_sha256 !== hashes.request) problems.push('input.request_sha256-mismatch');
    if (input.outbound_sha256 !== hashes.outbound) problems.push('input.outbound_sha256-mismatch');
    if (state?.schema_version !== SCHEMA_VERSION) problems.push('state.schema_version-invalid');
    for (const field of ['project_id', 'topic_id', 'run_id', 'exchange_id']) {
      if (state?.[field] !== input[field]) problems.push(`state.${field}-mismatch`);
    }

    // A record has to be where its own identifiers say it is, or a reply could
    // be read out of one exchange and reported as another.
    const parts = normalize(exchangeDir).split(/[\\/]/).filter(Boolean);
    if (parts.at(-1) !== input.exchange_id) problems.push('input.exchange_id-not-at-its-location');
    if (parts.at(-3) !== input.run_id) problems.push('input.run_id-not-at-its-location');
    if (parts.at(-5) !== input.topic_id) problems.push('input.topic_id-not-at-its-location');

    for (const attachment of Array.isArray(input.attachments) ? input.attachments : []) {
      if (!/^[a-f0-9]{64}$/.test(attachment?.sha256 ?? '')
        || attachment.relative_path !== `${EXCHANGE_FILES.attachments}/${attachment.sha256}`) {
        problems.push('attachment-reference-invalid');
        continue;
      }
      const path = join(exchangeDir, EXCHANGE_FILES.attachments, String(attachment?.sha256));
      safePath(path,{file:true,within:exchangeDir});
      if (!existsSync(path)) {
        problems.push(`attachment-missing-${attachment?.sha256}`);
        continue;
      }
      if (sha256Hex(readFileSync(path)) !== attachment.sha256) problems.push(`attachment-hash-mismatch-${attachment.sha256}`);
    }
  }

  let agentResult = null;
  if (seen(EXCHANGE_FILES.agentResult) !== null) {
    try {
      agentResult = readJsonFile(join(exchangeDir, EXCHANGE_FILES.agentResult), 'agent-result.json');
    } catch (error) {
      problems.push(`agent-result-${error.code ?? 'unreadable'}`);
    }
    if (agentResult !== null && hashes.reply !== null && agentResult.reply_sha256 !== hashes.reply) {
      problems.push('agent-result.reply_sha256-mismatch');
    }
    if (agentResult !== null) {
      problems.push(...savedResultProblems(agentResult));
      if(input !== null)for(const field of ['project_id','topic_id','run_id','exchange_id']) {
        if(agentResult[field]!==input[field])problems.push(`agent-result.${field}-mismatch`);
      }
    }
  }
  if (hashes.reply !== null && agentResult === null) problems.push('agent-result-missing');

  let completion = null;
  const completionPresent = seen(EXCHANGE_FILES.completion) !== null;
  if (completionPresent) {
    try {
      completion = readJsonFile(join(exchangeDir, EXCHANGE_FILES.completion), 'completion.json');
    } catch {
      problems.push('completion-unreadable');
    }
    if (completion !== null) {
      const shapeProblems = completionShapeProblems(completion);
      problems.push(...shapeProblems);
      // Recheck the original receipt on every completed read. An editable
      // successful summary cannot outweigh missing or unclean evidence.
      try{
        const receipt=readJsonFile(join(exchangeDir,'transport','receipt.json'),'transport receipt');
        if(completion.transport?.receipt_sha256!==sha256Hex(jsonBytes(receipt)))problems.push('completion.receipt_sha256-mismatch');
        for(const [key,value]of [['native_exit',receipt?.native_exit_code??null],['transport_exit',receipt?.transport_exit_code??null],['cleanup_complete',receipt?.cleanup?.cleanup_complete===true]]){
          if(completion.transport?.[key]!==value)problems.push('completion.transport.'+key+'-mismatch');
        }
        if(completion.status==='reply-ready'){
          const checks=existsSync(join(exchangeDir,'dispatch.json'))?fullTransportProblems(receipt):transportProblems(receipt);
          if(checks.length)problems.push('completion.receipt-not-successful');
        }
      }catch(e){problems.push('completion.receipt-unreadable');}
      if (completion.schema_version !== SCHEMA_VERSION) problems.push('completion.schema_version-unsupported');
      if (!COMPLETION_STATUSES.has(completion.status)) problems.push('completion.status-unknown');
      if (!DELIVERY_VALUES.has(completion.delivery)) problems.push('completion.delivery-unknown');
      if (completion.input_sha256 !== hashes.input) problems.push('completion.input_sha256-mismatch');
      if ((completion.reply_sha256 ?? null) !== hashes.reply) problems.push('completion.reply_sha256-mismatch');
      if (input !== null) {
        for (const field of ['project_id', 'topic_id', 'run_id', 'exchange_id']) {
          if (completion[field] !== input[field]) problems.push(`completion.${field}-mismatch`);
        }
      }
      if (agentResult !== null) {
        for (const [savedField, completionField] of [
          ['stop_reason', 'acp_stop_reason'], ['native_session_ref', 'native_session_ref'],
          ['continuity', 'continuity'], ['observed', 'observed'],
        ]) {
          if (!isDeepStrictEqual(agentResult[savedField], completion[completionField])) {
            problems.push(`completion.${completionField}-mismatch`);
          }
        }
        if (agentResult.error_code && !completion.error_code?.includes(agentResult.error_code)) {
          problems.push('completion.error_code-mismatch');
        }
      }
      const stop = completion.acp_stop_reason;
      const endedStatus = { refusal: 'refused', cancelled: 'cancelled', max_tokens: 'incomplete', max_turn_requests: 'incomplete' }[stop];
      if (endedStatus && completion.status !== endedStatus) problems.push('completion.status-stop-mismatch');
      if (['refused', 'cancelled'].includes(completion.status) && completion.status !== endedStatus) problems.push('completion.status-stop-mismatch');
      if (completion.status === 'reply-ready') {
        const body = hashes.reply === null ? '' : decodeUtf8Strict(readFileSync(join(exchangeDir, EXCHANGE_FILES.reply)), 'reply.md');
        if (stop !== 'end_turn' || completion.error_code !== null || !body.trim()
          || completion.delivery !== 'replied' || completion.transport?.native_exit !== 0
          || completion.transport?.transport_exit !== 0 || completion.transport?.cleanup_complete !== true) {
          problems.push('completion.status-not-supported');
        }
      }
      if (shapeProblems.length > 0) completion = null;
    }
  }

  const stage = completionPresent
    ? problems.length === 0 && completion !== null
      ? 'completed'
      : 'completion-unverified'
    : hashes.reply !== null
      ? agentResult !== null
        ? 'reply-saved-awaiting-completion'
        : 'reply-saved-without-agent-result'
      : evidenceRefs.includes(EXCHANGE_FILES.replyPartial)
        ? 'partial-reply-only'
        : state?.stage ?? 'unknown';

  return { state, input, agentResult, completion, completion_present: completionPresent, hashes, problems, evidence_refs: evidenceRefs, stage };
}

// ---------------------------------------------------------------------------
// Exchange: archiving
// ---------------------------------------------------------------------------

/**
 * Reads and checks every listed attachment without writing anything.
 *
 * Separate from writing on purpose: a request that is going to be refused must
 * be refused before any directory exists, so a rejected draft neither leaves
 * debris behind nor uses up its exchange id.
 */
function resolveAttachments(draft) {
  const allowed = new Set(draft.authorization.allowed_attachment_hashes);
  const resolved = [];

  for (const attachment of draft.attachments) {
    safePath(attachment?.source_file, { exists: true, file: true });
    if (typeof attachment?.source_file !== 'string' || attachment.source_file.length === 0) {
      fail('invalid-attachment', 'each attachment draft must name the local source_file to archive');
    }
    if (typeof attachment.source_revision !== 'string' || attachment.source_revision.length === 0) {
      fail('invalid-attachment', `attachment ${attachment.source_file} must carry a source_revision`);
    }
    if (!existsSync(attachment.source_file)) {
      fail('attachment-source-missing', `attachment source not found: ${attachment.source_file}`);
    }

    const bytes = readFileSync(attachment.source_file);
    const hash = sha256Hex(bytes);
    if (typeof attachment.sha256 === 'string' && attachment.sha256 !== hash) {
      fail('attachment-hash-mismatch', `${attachment.source_file} hashes to ${hash}, not the declared ${attachment.sha256}`);
    }
    // Being able to read a file locally is not permission to send it. Only a
    // hash the authorization lists may leave this machine.
    if (!allowed.has(hash)) {
      fail('attachment-not-authorized', `attachment ${hash} is not in the authorized hash list`);
    }

    const relativePath = `${EXCHANGE_FILES.attachments}/${hash}`;
    assertSafeRelative(relativePath, 'attachment relative_path');
    resolved.push({
      relative_path: relativePath,
      sha256: hash,
      source_revision: attachment.source_revision,
      bytes,
      text: decodeUtf8Strict(bytes, `attachment ${hash}`),
    });
  }
  return resolved;
}

function writeAttachments(exchangeDir, resolved) {
  if (resolved.length === 0) return;
  mkdirSync(join(exchangeDir, EXCHANGE_FILES.attachments), { recursive: true });
  for (const attachment of resolved) {
    const target = join(exchangeDir, EXCHANGE_FILES.attachments, attachment.sha256);
    if (!existsSync(target)) writeNewFile(target, attachment.bytes, `attachment ${attachment.sha256}`);
  }
}

/**
 * Decides whether a second draft describes the letter already archived here.
 *
 * The comparison rebuilds the outbound document and the Input record this
 * draft would produce and compares their hashes with what is on disk, rather
 * than listing fields to check one by one. A field nobody remembered to
 * compare is exactly how a withdrawn authorization or a changed source version
 * slips through as a match.
 *
 * Nothing outside the archive is opened: reading an old letter must keep
 * working after the original source document has moved or changed. A draft
 * that does not carry enough to be compared is reported as such rather than
 * assumed to be identical.
 */
function readBackArchivedExchange(exchangeDir, requestBytes, requestSha256, draft) {
  const evidence = evaluateExchangeEvidence(exchangeDir);
  if (evidence.problems.length > 0 || evidence.input === null) {
    fail(
      'archived-evidence-mismatch',
      `exchange ${draft.exchange_id} is on disk but no longer matches its own record: ${evidence.problems.join('; ')}`,
      [exchangeDir],
    );
  }

  if (evidence.hashes.request !== requestSha256) {
    fail('request-hash-mismatch', `exchange ${draft.exchange_id} already holds a different request; it is not rewritten`, [exchangeDir]);
  }
  if (typeof draft.request_sha256 === 'string' && draft.request_sha256 !== requestSha256) {
    fail('request-hash-mismatch', `this draft declares request ${draft.request_sha256}, but its bytes hash to ${requestSha256}`, [exchangeDir]);
  }

  const attachments = [];
  for (const [index, attachment] of draft.attachments.entries()) {
    if (typeof attachment?.sha256 !== 'string' || typeof attachment?.source_revision !== 'string') {
      fail(
        'duplicate-draft-incomplete',
        `attachment ${index} of this repeat draft gives no sha256 and source_revision, so it cannot be compared with what was archived`,
        [exchangeDir],
      );
    }
    const snapshot = join(exchangeDir, EXCHANGE_FILES.attachments, attachment.sha256);
    if (!existsSync(snapshot)) {
      fail('exchange-id-conflict', `this draft names attachment ${attachment.sha256}, which the archived letter never carried`, [exchangeDir]);
    }
    const bytes = readFileSync(snapshot);
    attachments.push({
      relative_path: `${EXCHANGE_FILES.attachments}/${attachment.sha256}`,
      sha256: attachment.sha256,
      source_revision: attachment.source_revision,
      text: decodeUtf8Strict(bytes, `attachment ${attachment.sha256}`),
    });
  }

  const requestText = decodeUtf8Strict(requestBytes, 'request.md');
  const outboundSha256 = sha256Hex(jsonBytes(buildOutboundDocument(requestText, attachments)));
  if (typeof draft.outbound_sha256 === 'string' && draft.outbound_sha256 !== outboundSha256) {
    fail('outbound-hash-mismatch', `this draft declares outbound ${draft.outbound_sha256}, but its content hashes to ${outboundSha256}`, [exchangeDir]);
  }
  if (outboundSha256 !== evidence.hashes.outbound) {
    fail('exchange-id-conflict', `this draft would send different content than the letter archived under ${draft.exchange_id}`, [exchangeDir]);
  }

  const candidateInputHash = sha256Hex(jsonBytes(buildInput(draft, requestSha256, outboundSha256, attachments)));
  if (candidateInputHash !== evidence.hashes.input) {
    fail(
      'exchange-id-conflict',
      `this draft differs from the input archived under ${draft.exchange_id} in what it authorizes or what it rests on`,
      [exchangeDir],
    );
  }

  return {
    exchangeDir,
    existing: true,
    inputHash: evidence.hashes.input,
    requestSha256,
    outboundSha256,
    topicId: evidence.input.topic_id,
  };
}

/**
 * Archives one outgoing letter, or reads back the one already archived under
 * the same id.
 *
 * The exchange id is the idempotency key. The same id with content that would
 * send, authorize and rest on exactly the same things returns what is on disk
 * and sends nothing new; anything else is refused, so a retry can never
 * quietly become a second delivery.
 */
export async function prepareExchange(recordRoot, runId, exchangeId, requestBytes, inputDraft, options = {}) {
  const gate = faultGate(options);
  assertUuid(exchangeId, 'exchange_id');
  const draft = assertInputDraft(inputDraft);
  if (draft.run_id !== runId) fail('invalid-input', `input.run_id ${draft.run_id} does not match the run being written to`);
  if (draft.exchange_id !== exchangeId) fail('invalid-input', 'input.exchange_id does not match the exchange id');

  const located = locateRun(recordRoot, runId);
  if (draft.topic_id !== located.topic_id) fail('run-topic-mismatch', `run ${runId} belongs to topic ${located.topic_id}`);
  const project = readProject(recordRoot);
  if (draft.project_id !== project.project_id) fail('project-mismatch', `these records belong to project ${project.project_id}`);

  const requestSha256 = sha256Hex(requestBytes);
  const dir = exchangeDirOf(recordRoot, located.topic_id, runId, exchangeId);

  // Reading back a letter already archived is a read, and it keeps working at
  // the revision that letter was written against, however far the premise has
  // moved on since.
  if (existsSync(dir) && existsSync(join(dir, EXCHANGE_FILES.state))) {
    return readBackArchivedExchange(dir, requestBytes, requestSha256, draft);
  }
  if (existsSync(dir)) {
    fail('exchange-archive-incomplete', `exchange ${exchangeId} has a partial archive with no state.json; recover it before reusing the id`, [dir]);
  }

  // From here on this is a new delivery, so it is measured against the premise
  // in force now and it is a write.
  const topic = readTopic(recordRoot, located.topic_id);
  if (draft.expected_topic_revision !== topic.revision) {
    fail(
      'topic-revision-mismatch',
      `topic ${located.topic_id} is at revision ${topic.revision}, the draft expects ${draft.expected_topic_revision}`,
    );
  }
  if (typeof draft.request_sha256 === 'string' && draft.request_sha256 !== requestSha256) {
    fail('request-hash-mismatch', `the request bytes hash to ${requestSha256}, not the declared ${draft.request_sha256}`);
  }
  ensureRecordRootWritable(recordRoot, options);

  const requestText = decodeUtf8Strict(requestBytes, 'request.md');

  // Everything that can refuse this letter happens first, while nothing has
  // been created yet.
  const attachments = resolveAttachments(draft);
  const outbound = buildOutboundDocument(requestText, attachments);
  const outboundBytes = jsonBytes(outbound);
  const outboundSha256 = sha256Hex(outboundBytes);
  if (typeof draft.outbound_sha256 === 'string' && draft.outbound_sha256 !== outboundSha256) {
    fail('outbound-hash-mismatch', `the outbound blocks hash to ${outboundSha256}, not the declared ${draft.outbound_sha256}`);
  }
  const input = buildInput(draft, requestSha256, outboundSha256, attachments);
  const inputBytes = jsonBytes(input);
  const inputHash = sha256Hex(inputBytes);

  mkdirSync(exchangesDir(recordRoot, located.topic_id, runId), { recursive: true });
  try {
    mkdirSync(dir, { recursive: false });
  } catch (error) {
    if (error.code === 'EEXIST') fail('exchange-id-conflict', `exchange ${exchangeId} was created by another writer`, [dir]);
    throw error;
  }

  writeNewFile(join(dir, EXCHANGE_FILES.request), Buffer.from(requestBytes), 'request.md');
  gate('request');

  writeAttachments(dir, attachments);
  gate('attachments');

  writeNewFile(join(dir, EXCHANGE_FILES.outbound), outboundBytes, 'outbound.json');
  gate('outbound');

  writeNewFile(join(dir, EXCHANGE_FILES.input), inputBytes, 'input.json');
  gate('input');

  writeMutableFile(
    join(dir, EXCHANGE_FILES.state),
    jsonBytes({
      schema_version: SCHEMA_VERSION,
      project_id: draft.project_id,
      topic_id: located.topic_id,
      run_id: runId,
      exchange_id: exchangeId,
      request_sha256: requestSha256,
      outbound_sha256: outboundSha256,
      input_sha256: inputHash,
      stage: 'archived',
      delivery: 'not-sent',
      archived_at: new Date().toISOString(),
    }),
  );
  gate('state');

  return { exchangeDir: dir, existing: false, inputHash, requestSha256, outboundSha256, topicId: located.topic_id };
}

export function readExchangeState(exchangeDir) {
  return readJsonFile(join(exchangeDir, EXCHANGE_FILES.state), 'state.json');
}

export function readArchivedInput(exchangeDir) {
  return readJsonFile(join(exchangeDir, EXCHANGE_FILES.input), 'input.json');
}

export function readOutbound(exchangeDir) {
  return readJsonFile(join(exchangeDir, EXCHANGE_FILES.outbound), 'outbound.json');
}

// ---------------------------------------------------------------------------
// Exchange: delivery, reply, completion
// ---------------------------------------------------------------------------

function updateState(exchangeDir, changes) {
  const state = readExchangeState(exchangeDir);
  const updated = { ...state, ...changes, updated_at: new Date().toISOString() };
  writeMutableFile(join(exchangeDir, EXCHANGE_FILES.state), jsonBytes(updated));
  return updated;
}

/**
 * Records that a prompt is about to go out, before it goes out.
 *
 * Written first on purpose: if this process dies a moment later, the record
 * says the delivery state is unknown, which is the truth, instead of saying
 * nothing was sent.
 */
export async function markDelivering(exchangeDir, options = {}) {
  const gate = faultGate(options);
  const state = readExchangeState(exchangeDir);
  if (state.delivery !== 'not-sent') return state;
  const updated = updateState(exchangeDir, { stage: 'prompt-sent', delivery: 'unknown' });
  gate('delivering');
  return updated;
}

/** Keeps the text received so far where a crash cannot pass it off as a reply. */
export async function savePartialReply(exchangeDir, text, options = {}) {
  const gate = faultGate(options);
  if (typeof text !== 'string') fail('invalid-reply', 'partial reply text must be a string');
  writeMutableFile(join(exchangeDir, EXCHANGE_FILES.replyPartial), Buffer.from(text, 'utf8'));
  gate('partial');
  return join(exchangeDir, EXCHANGE_FILES.replyPartial);
}

/** Archives the finished reply body and the raw ACP result behind it. */
export async function saveReply(exchangeDir, agentResult, options = {}) {
  const gate = faultGate(options);
  if (typeof agentResult?.replyText !== 'string') fail('invalid-reply', 'agentResult.replyText must be a string');

  const replyBytes = Buffer.from(agentResult.replyText, 'utf8');
  const input = readArchivedInput(exchangeDir);
  writeNewFile(join(exchangeDir, EXCHANGE_FILES.reply), replyBytes, 'reply.md');
  gate('reply');

  writeNewFile(
    join(exchangeDir, EXCHANGE_FILES.agentResult),
    jsonBytes({
      schema_version: SCHEMA_VERSION,
      project_id: input.project_id, topic_id: input.topic_id, run_id: input.run_id, exchange_id: input.exchange_id,
      stop_reason: agentResult.stopReason ?? null,
      native_session_ref: agentResult.nativeSessionRef ?? null,
      continuity: agentResult.continuity ?? 'new',
      observed: agentResult.observed ?? { model: null, thinking: null, source: 'unknown' },
      error_code: agentResult.errorCode ?? null,
      reviewer_process: agentResult.reviewerProcess ?? null,
      reply_sha256: sha256Hex(replyBytes),
      saved_at: new Date().toISOString(),
    }),
    'agent-result.json',
  );
  gate('agent-result');

  rmSync(join(exchangeDir, EXCHANGE_FILES.replyPartial), { force: true });
  updateState(exchangeDir, { stage: 'replied', delivery: 'replied', reply_sha256: sha256Hex(replyBytes) });
  return { reply_sha256: sha256Hex(replyBytes) };
}

// An error without a final ACP stop is not a reply. Keep partial bytes and
// result metadata, leaving delivery not-sent or unknown as already recorded.
export async function saveUnconfirmedResult(exchangeDir, result) {
  const input=readArchivedInput(exchangeDir);
  if(result.stopReason!==null)fail('invalid-unconfirmed-result','a final stop belongs in saveReply');
  if(result.replyText)await savePartialReply(exchangeDir,result.replyText);
  writeNewFile(join(exchangeDir,EXCHANGE_FILES.agentResult),jsonBytes({
    schema_version:1,project_id:input.project_id,topic_id:input.topic_id,run_id:input.run_id,exchange_id:input.exchange_id,
    stop_reason:null,native_session_ref:result.nativeSessionRef??null,continuity:result.continuity??'new',
    observed:result.observed??{model:null,thinking:null,source:'unknown'},error_code:result.errorCode??null,
    reviewer_process:result.reviewerProcess??{exitCode:null,closeReason:'unobserved'},reply_sha256:null,
    prompts_submitted:result.promptsSubmitted??0,saved_at:new Date().toISOString(),
  }),'agent-result.json');
  updateState(exchangeDir,{stage:readExchangeState(exchangeDir).delivery==='not-sent'?'not-sent':'turn-unconfirmed'});
}

export async function appendNote(recordRoot,runId,kind,bytes,expectedRevision) {
  if(!['handoff','adoption','premise-change'].includes(kind))fail('invalid-note-kind','unsupported note kind');
  decodeUtf8Strict(bytes,'note');ensureRecordRootWritable(recordRoot);
  const run=readRun(recordRoot,runId);const lock=await acquireStoreLock(recordRoot,'topic',{topicId:run.topic_id});
  let result;
  try{
    const topic=readTopic(recordRoot,run.topic_id);
    if(topic.revision!==expectedRevision)fail('topic-revision-mismatch','note is based on an old premise');
    const notes=join(topicDir(recordRoot,run.topic_id),'notes');safePath(notes);mkdirSync(notes,{recursive:true});
    const id=newUuid(),revision=topic.revision+(kind==='premise-change'?1:0);
    writeNewFile(join(notes,id+'.md'),bytes,'note');
    writeNewFile(join(notes,id+'.json'),jsonBytes({schema_version:1,note_id:id,run_id:runId,kind,sha256:sha256Hex(bytes),previous_revision:topic.revision,revision}),'note metadata');
    // This single mutable topic record commits the note and premise together.
    // Interrupted earlier files are uncommitted and are not auto-adopted.
    writeMutableFile(topicFile(recordRoot,run.topic_id),jsonBytes({...topic,revision,note_ids:[...(topic.note_ids??[]),id]}));
    result={note_id:id,note_file:join(notes,id+'.md'),revision};
  }finally{lock.release();}
  await rebuildIndex(recordRoot);return result;
}

/**
 * Compares the result a caller is committing with the one already saved.
 *
 * The saved record is what the endpoint actually returned. A caller argument
 * may not stand in for it, and may not quietly replace it: a turn saved as
 * cancelled does not become a normal completion because the next call says so.
 */
function reconcileWithSavedResult(exchangeDir, evidence, agentResult) {
  if (evidence.hashes.reply === null) return [];
  if (evidence.agentResult === null) return ['agent-result-missing'];

  const saved = evidence.agentResult;
  const savedStop = saved.stop_reason ?? null;
  const callerStop = agentResult?.stopReason ?? null;
  if (savedStop !== callerStop) {
    fail(
      'agent-result-mismatch',
      `the saved result ended with ${JSON.stringify(savedStop)} but this call reports ${JSON.stringify(callerStop)}`,
      [join(exchangeDir, EXCHANGE_FILES.agentResult)],
    );
  }
  const savedError = saved.error_code ?? null;
  const callerError = agentResult?.errorCode ?? null;
  if (savedError !== callerError) {
    fail(
      'agent-result-mismatch',
      `the saved result recorded error ${JSON.stringify(savedError)} but this call reports ${JSON.stringify(callerError)}`,
      [join(exchangeDir, EXCHANGE_FILES.agentResult)],
    );
  }
  for (const [savedField, callerField] of [
    ['native_session_ref', 'nativeSessionRef'], ['continuity', 'continuity'],
    ['observed', 'observed'], ['reviewer_process', 'reviewerProcess'],
  ]) {
    if (!isDeepStrictEqual(saved[savedField], agentResult?.[callerField])) {
      fail('agent-result-mismatch', `saved ${savedField} does not match the caller`, [join(exchangeDir, EXCHANGE_FILES.agentResult)]);
    }
  }
  if (typeof agentResult?.replyText === 'string' && sha256Hex(Buffer.from(agentResult.replyText, 'utf8')) !== evidence.hashes.reply) {
    fail('agent-result-mismatch', 'the reply text in this call is not the one archived for this exchange', [
      join(exchangeDir, EXCHANGE_FILES.reply),
    ]);
  }
  return [];
}

/**
 * Publishes the completion, last of all and in one step.
 *
 * Everything it summarises has to already be on disk and still hash to what
 * the record claims, including the agent result behind the reply and every
 * listed attachment. A completion already published is never replaced; if the
 * evidence under it has since changed, that is reported rather than answered
 * with the old success.
 */
export async function commitCompletion(exchangeDir, agentResult, transportReceipt, options = {}) {
  const gate = faultGate(options);
  const evidence = evaluateExchangeEvidence(exchangeDir);
  if (evidence.state === null || evidence.input === null) {
    fail('archive-incomplete', `exchange at ${exchangeDir} has no complete archive to complete`, [exchangeDir]);
  }

  const completionPath = join(exchangeDir, EXCHANGE_FILES.completion);
  if (evidence.completion_present) {
    if (evidence.problems.length > 0 || evidence.completion === null) {
      fail(
        'completion-unverified',
        `a completion is already published for ${evidence.input.exchange_id}, but the evidence under it no longer supports it: ${evidence.problems.join('; ')}`,
        [completionPath],
      );
    }
    return evidence.completion;
  }

  const replyText = evidence.hashes.reply === null
    ? null
    : decodeUtf8Strict(readFileSync(join(exchangeDir, EXCHANGE_FILES.reply)), 'reply.md');

  const evidenceProblems = [...evidence.problems, ...(options.receiptProblems ?? []), ...reconcileWithSavedResult(exchangeDir, evidence, agentResult)];
  const savedResult = evidence.agentResult !== null && savedResultProblems(evidence.agentResult).length === 0
    ? resultFromSaved(evidence.agentResult, replyText) : agentResult;

  const outcome = classifyOutcome({
    agentResult: savedResult,
    receipt: transportReceipt,
    deliveryOnDisk: evidence.state.delivery,
    replyText,
    evidenceConsistent: evidenceProblems.length === 0,
    evidenceProblems,
  });

  const completion = buildCompletion({
    input: evidence.input,
    inputSha256: evidence.hashes.input,
    replySha256: evidence.hashes.reply,
    outcome,
    agentResult: savedResult,
    receipt: transportReceipt,
  });

  const receiptDir=join(exchangeDir,'transport');safePath(receiptDir);mkdirSync(receiptDir,{recursive:true});
  const receiptPath=join(receiptDir,'receipt.json');
  if(existsSync(receiptPath)){
    if(!isDeepStrictEqual(readJsonFile(receiptPath,'transport receipt'),transportReceipt))fail('saved-receipt-mismatch','original receipt cannot be replaced');
  }else publishFileAtomically(receiptPath,jsonBytes(transportReceipt),'transport receipt');

  gate('completion');
  publishFileAtomically(completionPath, jsonBytes(completion), 'completion.json', gate, 'completion-during-write');
  updateState(exchangeDir, { stage: 'completed', delivery: completion.delivery, completion_status: completion.status });
  return completion;
}

/**
 * Reads what the disk can prove about one exchange.
 *
 * Nothing is sent, no model is called and no missing evidence is invented. A
 * turn whose outer receipt has not been written yet is still in progress, not
 * permanently lost. Damage is reported with the files that show it, and never
 * cleaned up on the reader's initiative.
 */
export async function recoverExchange(exchangeDir) {
  const evidence = evaluateExchangeEvidence(exchangeDir);

  if (evidence.state === null) {
    return {
      status: 'failed',
      delivery: 'not-sent',
      stage: 'archive-incomplete',
      problems: evidence.problems,
      evidence_refs: evidence.evidence_refs,
    };
  }

  if (evidence.completion_present) {
    const verified = evidence.problems.length === 0 && evidence.completion !== null;
    return {
      status: verified ? evidence.completion.status : 'failed',
      delivery: verified ? evidence.completion.delivery : evidence.completion?.delivery ?? evidence.state.delivery,
      stage: verified ? 'completed' : 'completion-unverified',
      problems: evidence.problems,
      evidence_refs: evidence.evidence_refs,
      ...(evidence.completion !== null ? { completion: evidence.completion } : {}),
    };
  }

  const replyText = evidence.hashes.reply === null
    ? null
    : decodeUtf8Strict(readFileSync(join(exchangeDir, EXCHANGE_FILES.reply)), 'reply.md');

  const outcome = classifyOutcome({
    agentResult: null,
    // No outer receipt has been read here. That is not the same as a receipt
    // that said something bad, and it must not become a permanent verdict.
    receipt: null,
    deliveryOnDisk: evidence.state.delivery,
    replyText,
    evidenceConsistent: evidence.problems.length === 0,
    evidenceProblems: evidence.problems,
  });

  return {
    status: evidence.hashes.reply !== null || (evidence.state.delivery === 'not-sent' && evidence.problems.length === 0 && evidence.agentResult === null) ? 'unconfirmed' : outcome.status,
    delivery: evidence.state.delivery,
    stage: evidence.stage,
    problems: evidence.problems,
    evidence_refs: evidence.evidence_refs,
  };
}
