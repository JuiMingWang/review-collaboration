// Schema, identifiers, record paths and outcome classification.
//
// Nothing here touches the file system. This module answers "is this well
// formed" and "what does this set of facts mean", so that mail-store.mjs can be
// only about writing bytes safely. Field names follow the plan's data contract;
// no second naming scheme is invented here.

import { createHash, randomUUID } from 'node:crypto';
import { join, isAbsolute, normalize } from 'node:path';

export const SCHEMA_VERSION = 1;
export const RECORD_DIR_NAME = '.review-collaboration';

/** An error that names a stable machine-readable cause. */
export class StoreError extends Error {
  constructor(code, message, evidenceRefs = []) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
    this.code = code;
    this.evidence_refs = evidenceRefs;
  }
}

export function fail(code, message, evidenceRefs = []) {
  throw new StoreError(code, message, evidenceRefs);
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

// Generated ids come from randomUUID, which is lowercase RFC 4122. Accepting
// only that shape keeps a caller from turning a title, a path fragment or a
// native session id into a directory name.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newUuid() {
  return randomUUID();
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function assertUuid(value, field) {
  if (!isUuid(value)) fail('invalid-id', `${field} must be a lowercase RFC 4122 UUID, got ${JSON.stringify(value)}`);
  return value;
}

// ---------------------------------------------------------------------------
// Bytes and text
// ---------------------------------------------------------------------------

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Decodes archived text. A byte order mark at the very start is allowed and
 * dropped; anything that is not valid UTF-8 is refused rather than replaced
 * with substitution characters, because a silently mangled letter is worse
 * than a refused one.
 */
export function decodeUtf8Strict(bytes, label) {
  let view = Uint8Array.prototype.subarray.call(bytes, 0);
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) view = view.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(view);
  } catch {
    return fail('invalid-utf8', `${label} is not valid UTF-8`);
  }
}

export function encodeUtf8(text) {
  return Buffer.from(text, 'utf8');
}

/** Stable bytes for a JSON document: what is written is what is hashed. */
export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Record paths
// ---------------------------------------------------------------------------

export const EXCHANGE_FILES = {
  input: 'input.json',
  request: 'request.md',
  outbound: 'outbound.json',
  state: 'state.json',
  reply: 'reply.md',
  replyPartial: 'reply.md.partial',
  agentResult: 'agent-result.json',
  completion: 'completion.json',
  cancelRequest: 'cancel.request.json',
  attachments: 'attachments',
  transport: 'transport',
};

export function recordRootFor(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || !isAbsolute(projectRoot)) {
    fail('invalid-project-root', 'project_root must be an absolute path');
  }
  return join(projectRoot, RECORD_DIR_NAME);
}

export const projectFile = (recordRoot) => join(recordRoot, 'project.json');
export const indexFile = (recordRoot) => join(recordRoot, 'index.md');
export const indexLockFile = (recordRoot) => join(recordRoot, 'index.lock');
export const gitignoreFile = (recordRoot) => join(recordRoot, '.gitignore');
export const topicsDir = (recordRoot) => join(recordRoot, 'topics');
export const topicDir = (recordRoot, topicId) => join(topicsDir(recordRoot), assertUuid(topicId, 'topic_id'));
export const topicFile = (recordRoot, topicId) => join(topicDir(recordRoot, topicId), 'topic.json');
export const topicLockFile = (recordRoot, topicId) => join(topicDir(recordRoot, topicId), 'topic.lock');
export const runsDir = (recordRoot, topicId) => join(topicDir(recordRoot, topicId), 'runs');
export const runDir = (recordRoot, topicId, runId) => join(runsDir(recordRoot, topicId), assertUuid(runId, 'run_id'));
export const runFile = (recordRoot, topicId, runId) => join(runDir(recordRoot, topicId, runId), 'run.json');
export const runLockFile = (recordRoot, topicId, runId) => join(runDir(recordRoot, topicId, runId), 'run.lock');
export const exchangesDir = (recordRoot, topicId, runId) => join(runDir(recordRoot, topicId, runId), 'exchanges');
export const exchangeDirOf = (recordRoot, topicId, runId, exchangeId) =>
  join(exchangesDir(recordRoot, topicId, runId), assertUuid(exchangeId, 'exchange_id'));

/**
 * A path recorded inside the records is relative to the record root, so the
 * whole folder can be moved to another machine and still read.
 */
export function toRecordRelative(recordRoot, absolutePath) {
  const root = normalize(recordRoot).replace(/[\\/]+$/, '');
  const target = normalize(absolutePath);
  if (!target.toLowerCase().startsWith(`${root.toLowerCase()}\\`) && target.toLowerCase() !== root.toLowerCase()) {
    fail('path-outside-record-root', `${absolutePath} is not inside ${recordRoot}`);
  }
  return target.slice(root.length + 1).replace(/\\/g, '/');
}

// A stored relative path must stay a plain relative path: no drive letter, no
// climbing out with "..", no absolute form. This is checked when writing and
// again when reading, because records travel between machines.
export function assertSafeRelative(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail('invalid-relative-path', `${field} must be a non-empty string`);
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    fail('invalid-relative-path', `${field} must not be absolute: ${value}`);
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((s) => s === '..' || s === '.' || s.length === 0)) {
    fail('invalid-relative-path', `${field} must not contain traversal segments: ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Structural checks for material handed in from outside this module
// ---------------------------------------------------------------------------

const REQUESTED_VALUE_SOURCES = new Set(['provider-default', 'user']);

export function assertSelection(selection) {
  if (selection === null || typeof selection !== 'object') fail('invalid-selection', 'selection must be an object');
  for (const field of ['host_id', 'reviewer_tool_id', 'route_id']) {
    if (typeof selection[field] !== 'string' || selection[field].length === 0) {
      fail('invalid-selection', `selection.${field} must be a non-empty string`);
    }
  }
  for (const field of ['model', 'thinking']) {
    const requested = selection[field];
    if (requested === null || typeof requested !== 'object' || !REQUESTED_VALUE_SOURCES.has(requested.source)) {
      fail('invalid-selection', `selection.${field} must be a RequestedValue`);
    }
    if (requested.source === 'provider-default' && requested.value !== null) {
      fail('invalid-selection', `selection.${field}.value must be null for a provider default`);
    }
    if (requested.source === 'user' && typeof requested.value !== 'string') {
      fail('invalid-selection', `selection.${field}.value must be a string when the user chose it`);
    }
  }
  return selection;
}

/**
 * Checks that a Route snapshot is structurally complete enough to be copied
 * into a run record. This is NOT route verification: whether the route really
 * reaches a reviewer is decided in T3 and is not claimed by storing it.
 */
export function assertRouteSnapshot(route) {
  if (route === null || typeof route !== 'object') fail('invalid-route', 'route must be an object');
  if (route.schema_version !== SCHEMA_VERSION) fail('invalid-route', 'route.schema_version must be 1');
  if (route.kind !== 'acp') fail('invalid-route', 'route.kind must be acp');
  if (typeof route.route_id !== 'string' || route.route_id.length === 0) fail('invalid-route', 'route.route_id is required');
  if (typeof route.fingerprint !== 'string' || route.fingerprint.length === 0) fail('invalid-route', 'route.fingerprint is required');
  const launch = route.launch;
  if (launch === null || typeof launch !== 'object' || typeof launch.executable !== 'string' || !Array.isArray(launch.arguments)) {
    fail('invalid-route', 'route.launch must carry an executable and an argument array');
  }
  const verification = route.verification;
  if (verification === null || typeof verification !== 'object' || typeof verification.level !== 'string') {
    fail('invalid-route', 'route.verification.level is required');
  }
  return route;
}

const AUTHORIZATION_SCOPES = new Set(['text-and-listed-snapshots']);

export function assertAuthorization(authorization) {
  if (authorization === null || typeof authorization !== 'object') fail('invalid-authorization', 'authorization must be an object');
  if (typeof authorization.ref !== 'string' || authorization.ref.length === 0) {
    fail('invalid-authorization', 'authorization.ref must be a non-empty string');
  }
  if (!Array.isArray(authorization.allowed_attachment_hashes)) {
    fail('invalid-authorization', 'authorization.allowed_attachment_hashes must be an array');
  }
  for (const hash of authorization.allowed_attachment_hashes) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      fail('invalid-authorization', `allowed_attachment_hashes must be lowercase sha-256 hex, got ${JSON.stringify(hash)}`);
    }
  }
  if (!AUTHORIZATION_SCOPES.has(authorization.scope)) {
    fail('invalid-authorization', `authorization.scope ${JSON.stringify(authorization.scope)} is not supported`);
  }
  return authorization;
}

/**
 * Checks the draft Input a caller hands to prepareExchange. request_sha256 and
 * outbound_sha256 may be left out and computed here; if given they must agree
 * with the bytes actually archived.
 */
export function assertInputDraft(draft) {
  if (draft === null || typeof draft !== 'object') fail('invalid-input', 'input draft must be an object');
  if (draft.schema_version !== SCHEMA_VERSION) fail('invalid-input', 'input.schema_version must be 1');
  for (const field of ['project_id', 'topic_id', 'run_id', 'exchange_id']) assertUuid(draft[field], `input.${field}`);
  if (draft.previous_exchange_id !== null) assertUuid(draft.previous_exchange_id, 'input.previous_exchange_id');
  if (!Number.isInteger(draft.expected_topic_revision) || draft.expected_topic_revision < 1) {
    fail('invalid-input', 'input.expected_topic_revision must be a positive integer');
  }
  if (!Array.isArray(draft.attachments)) fail('invalid-input', 'input.attachments must be an array');
  if(draft.continuity!==undefined&&!['auto','letters-reconstructed'].includes(draft.continuity))fail('invalid-continuity','unsupported continuation mode');
  assertAuthorization(draft.authorization);
  return draft;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * The exact text blocks that will be handed to the endpoint.
 *
 * Built once, here, and archived: the ACP client sends what is in this file and
 * composes nothing of its own. Nothing time-dependent and no local absolute
 * path goes in, so the same letter always hashes the same way.
 */
export function buildOutboundDocument(requestText, attachments) {
  const blocks = [{ type: 'text', text: requestText }];
  for (const attachment of attachments) {
    const header = `--- attachment ${attachment.relative_path} (source_revision ${attachment.source_revision}, sha256 ${attachment.sha256}) ---`;
    blocks.push({ type: 'text', text: `${header}\n${attachment.text}` });
  }
  return { schema_version: SCHEMA_VERSION, content_blocks: blocks };
}

/** The Input record, in the field order of the plan's contract. */
export function buildInput(draft, requestSha256, outboundSha256, attachments) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: draft.project_id,
    topic_id: draft.topic_id,
    run_id: draft.run_id,
    exchange_id: draft.exchange_id,
    previous_exchange_id: draft.previous_exchange_id ?? null,
    continuity: draft.continuity ?? 'auto',
    expected_topic_revision: draft.expected_topic_revision,
    request_sha256: requestSha256,
    outbound_sha256: outboundSha256,
    attachments: attachments.map((a) => ({
      relative_path: a.relative_path,
      sha256: a.sha256,
      source_revision: a.source_revision,
    })),
    authorization: {
      ref: draft.authorization.ref,
      allowed_attachment_hashes: [...draft.authorization.allowed_attachment_hashes],
      scope: draft.authorization.scope,
    },
  };
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

// What the outer transport must say before a turn may be called finished.
// Every entry must be present with exactly this value: an absent field is a
// problem, never a default that happens to look like success.
const RECEIPT_REQUIRED = [
  ['transport_status', 'success'],
  ['transport_exit_code', 0],
  ['native_exit_code', 0],
  ['stdout_truncated', false],
  ['stderr_truncated', false],
];
const CAPTURE_ERROR_FIELDS = ['stdout_error', 'stderr_error', 'stdin_error', 'launch_error'];

const hasField = (object, field) => Object.prototype.hasOwnProperty.call(object, field);

/** Everything wrong with an outer process receipt, named field by field. */
export function transportProblems(receipt) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return ['transport-receipt-absent'];
  const problems = [];
  for (const [field, expected] of RECEIPT_REQUIRED) {
    if (!hasField(receipt, field)) problems.push(`missing-${field}`);
    else if (receipt[field] !== expected) problems.push(`${field}=${JSON.stringify(receipt[field])}`);
  }
  const cleanup = receipt.cleanup;
  if (cleanup === null || typeof cleanup !== 'object') problems.push('cleanup-absent');
  else if (!hasField(cleanup, 'cleanup_complete')) problems.push('cleanup.missing-cleanup_complete');
  else if (cleanup.cleanup_complete !== true) problems.push(`cleanup.cleanup_complete=${JSON.stringify(cleanup.cleanup_complete)}`);
  const capture = receipt.capture;
  if (capture === null || typeof capture !== 'object') problems.push('capture-absent');
  else {
    for (const field of CAPTURE_ERROR_FIELDS) {
      if (!hasField(capture, field)) problems.push(`capture.missing-${field}`);
      else if (capture[field] !== null) problems.push(`capture.${field}=${JSON.stringify(capture[field])}`);
    }
  }
  return problems;
}

/** Full ProcessTransport contract used by the public invocation/finalizer. */
export function fullTransportProblems(receipt){
  const problems=transportProblems(receipt);
  for(const [field,value]of [['schema_version',1],['process_started',true],['timed_out',false]])if(receipt?.[field]!==value)problems.push('receipt-'+field);
  for(const [field,value]of [['job_created',true],['job_attached',true],['process_exited',true],['stdin_completed',true],['stdout_completed',true],['stderr_completed',true],['stream_wait_timed_out',false],['owned_processes_remaining',0]])if(receipt?.cleanup?.[field]!==value)problems.push('receipt-cleanup-'+field);
  if(!Object.hasOwn(receipt?.cleanup??{},'tree_terminated'))problems.push('receipt-cleanup-tree_terminated');
  return problems;
}

// A stop reason is a turn result that actually came back. Whether the turn
// carried text is a separate question from whether it ended, and the two are
// not allowed to overwrite each other.
const STOP_REASON_STATUS = new Map([
  ['end_turn', 'reply-ready'],
  ['refusal', 'refused'],
  ['cancelled', 'cancelled'],
  ['max_tokens', 'incomplete'],
  ['max_turn_requests', 'incomplete'],
]);

export const COMPLETION_STATUSES = new Set(['reply-ready', 'incomplete', 'refused', 'cancelled', 'failed', 'unconfirmed']);
export const DELIVERY_VALUES = new Set(['not-sent', 'unknown', 'replied']);

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNullableText = v => v === null || typeof v === 'string';
const CONTINUITIES = new Set(['new', 'native-resume', 'letters-reconstructed']);
const validObserved = v => isRecord(v) && isNullableText(v.model) && isNullableText(v.thinking)
  && ['unknown', 'provider-reported'].includes(v.source);
const validExit = v => v === null || Number.isInteger(v);

/** Structural checks do not infer missing fields from a successful-looking flag. */
export function savedResultProblems(value) {
  if (!isRecord(value)) return ['agent-result-not-object'];
  const problems = [];
  const require = (field, ok) => { if (!ok) problems.push(`agent-result.${field}-invalid`); };
  require('schema_version', value.schema_version === 1);
  require('stop_reason', isNullableText(value.stop_reason));
  require('error_code', isNullableText(value.error_code));
  require('native_session_ref', isNullableText(value.native_session_ref));
  require('continuity', CONTINUITIES.has(value.continuity));
  require('observed', validObserved(value.observed));
  require('reply_sha256', (value.stop_reason === null && value.reply_sha256 === null) || (typeof value.reply_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.reply_sha256)));
  require('reviewer_process', isRecord(value.reviewer_process) && validExit(value.reviewer_process.exitCode)
    && ['graceful', 'controlled-stop', 'unexpected', 'unobserved'].includes(value.reviewer_process.closeReason));
  return problems;
}

export function resultFromSaved(saved, replyText) {
  return {
    replyText, stopReason: saved.stop_reason, errorCode: saved.error_code,
    nativeSessionRef: saved.native_session_ref, continuity: saved.continuity,
    observed: saved.observed, reviewerProcess: saved.reviewer_process,
  };
}

export function completionShapeProblems(value) {
  if (!isRecord(value)) return ['completion-not-object'];
  const problems = [];
  const require = (field, ok) => { if (!ok) problems.push(`completion.${field}-invalid`); };
  require('schema_version', value.schema_version === 1);
  for (const field of ['project_id', 'topic_id', 'run_id', 'exchange_id']) require(field, isUuid(value[field]));
  require('input_sha256', typeof value.input_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.input_sha256));
  require('reply_sha256', value.reply_sha256 === null || (typeof value.reply_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.reply_sha256)));
  require('status', COMPLETION_STATUSES.has(value.status));
  require('delivery', DELIVERY_VALUES.has(value.delivery));
  require('acp_stop_reason', isNullableText(value.acp_stop_reason));
  require('error_code', isNullableText(value.error_code));
  require('continuity', CONTINUITIES.has(value.continuity));
  require('native_session_ref', isNullableText(value.native_session_ref));
  require('observed', validObserved(value.observed));
  require('transport', isRecord(value.transport) && validExit(value.transport.native_exit)
    && validExit(value.transport.transport_exit) && typeof value.transport.cleanup_complete === 'boolean');
  require('semantic_acceptance', value.semantic_acceptance === 'pending');
  return problems;
}

/**
 * Turns the facts on disk into the delivery and status of a completion.
 *
 * Three rules decide everything here:
 *
 *   - reply-ready needs all of it: end_turn, a non-empty body, no reported
 *     error, evidence that still matches the record, and a clean outer
 *     receipt. Any one of those missing means it is not a normal completion.
 *   - a stop reason that was received keeps its meaning whether or not text
 *     came with it. A refusal with nothing to say is still a refusal.
 *   - no turn result at all is unconfirmed. Silence is not an ending.
 */
export function classifyOutcome({ agentResult, receipt, deliveryOnDisk, replyText, evidenceConsistent, evidenceProblems = [] }) {
  const problems = transportProblems(receipt);
  const hasBody = typeof replyText === 'string' && replyText.trim().length > 0;
  const errorCode = agentResult?.errorCode ?? null;
  const stopReason = agentResult?.stopReason ?? null;
  const turnEnded = STOP_REASON_STATUS.has(stopReason);

  if (deliveryOnDisk === 'not-sent') {
    return {
      delivery: 'not-sent',
      status: 'failed',
      error_code: errorCode ?? 'not-sent-before-prompt',
    };
  }

  if (!turnEnded && !hasBody) {
    const parts = [errorCode, ...problems].filter(Boolean);
    return {
      delivery: 'unknown',
      status: 'unconfirmed',
      error_code: parts.length > 0 ? parts.join('; ') : null,
    };
  }

  const parts = [];
  if (errorCode) parts.push(errorCode);
  // Name the actual gaps when they are known. "Something did not match" is not
  // enough for the reader to tell a tampered attachment from a missing agent
  // result.
  if (evidenceConsistent !== true) {
    parts.push(...(evidenceProblems.length > 0 ? evidenceProblems : ['archived-evidence-mismatch']));
  }
  parts.push(...problems);

  let status = STOP_REASON_STATUS.get(stopReason) ?? 'incomplete';
  if (status === 'reply-ready') {
    if (!hasBody) {
      status = 'failed';
      if(!parts.includes('empty-reply'))parts.push('empty-reply');
    } else if (parts.length > 0) {
      status = 'failed';
    }
  }

  return {
    delivery: 'replied',
    status,
    error_code: parts.length > 0 ? parts.join('; ') : null,
  };
}

/** The Completion record, in the field order of the plan's contract. */
export function buildCompletion({ input, inputSha256, replySha256, outcome, agentResult, receipt }) {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: input.project_id,
    topic_id: input.topic_id,
    run_id: input.run_id,
    exchange_id: input.exchange_id,
    input_sha256: inputSha256,
    reply_sha256: replySha256,
    delivery: outcome.delivery,
    status: outcome.status,
    acp_stop_reason: agentResult?.stopReason ?? null,
    error_code: outcome.error_code,
    continuity: agentResult?.continuity ?? 'new',
    native_session_ref: agentResult?.nativeSessionRef ?? null,
    observed: {
      model: agentResult?.observed?.model ?? null,
      thinking: agentResult?.observed?.thinking ?? null,
      source: agentResult?.observed?.source ?? 'unknown',
    },
    transport: {
      receipt_sha256: sha256Hex(jsonBytes(receipt)),
      native_exit: receipt && typeof receipt === 'object' ? receipt.native_exit_code ?? null : null,
      transport_exit: receipt && typeof receipt === 'object' ? receipt.transport_exit_code ?? null : null,
      cleanup_complete: receipt && typeof receipt === 'object' ? receipt.cleanup?.cleanup_complete === true : false,
    },
    // The tool checks hashes and scope. Whether the reply is a good review is
    // the main agent's call and is never decided here.
    semantic_acceptance: 'pending',
  };
}
