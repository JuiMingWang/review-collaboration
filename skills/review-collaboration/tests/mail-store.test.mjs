// Persistent mail store.
//
// What is covered here is the record layer only: archiving, hashes, locks,
// completion and recovery. No reviewer, no model and no ACP connection is
// involved. Where a real turn would hand the letter to an endpoint, these tests
// count how many times the store let a caller reach that step, which is a proxy
// for a prompt count and is named as one wherever it is used.
//
// The concurrency cases run real separate processes (tests/fixtures/
// store-worker.mjs), because an exclusive file lock is a claim about processes,
// not about callbacks inside one of them.
//
// Every fixture builds its own synthetic project, topic and run under a
// temporary directory and removes only that directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commitCompletion,
  createTopic,
  initProject,
  locateTopic,
  markDelivering,
  openRun,
  prepareExchange,
  readArchivedInput,
  readExchangeState,
  readIndex,
  readProject,
  rebuildIndex,
  recoverExchange,
  recoverRun,
  releaseRunLock,
  saveReply,
  savePartialReply,
  withRunLock,
} from '../scripts/lib/mail-store.mjs';

// Namespace import as well, so a case for an export that does not exist yet fails on
// its own instead of stopping the whole file from loading.
import * as store from '../scripts/lib/mail-store.mjs';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const WORKER = join(testsRoot, 'fixtures', 'store-worker.mjs');

const SYNTHETIC_SELECTION = {
  host_id: 'synthetic-host',
  reviewer_tool_id: 'synthetic-reviewer',
  route_id: '00000000-0000-4000-8000-00000000a001',
  model: { source: 'provider-default', value: null },
  thinking: { source: 'provider-default', value: null },
};

const SYNTHETIC_ROUTE = {
  schema_version: 1,
  route_id: SYNTHETIC_SELECTION.route_id,
  reviewer_tool_id: 'synthetic-reviewer',
  kind: 'acp',
  launch: { executable: 'C:\\synthetic\\node.exe', arguments: ['C:\\synthetic\\endpoint.mjs'] },
  source: { url: 'https://synthetic.invalid/route', revision: 'synthetic-0', manifest_sha256: 'f'.repeat(64) },
  fingerprint: 'synthetic-fingerprint',
  configuration: [],
  material_control: { status: 'unverified', evidence_ref: null },
  verification: { level: 'discovered', evidence_ref: null },
};

const REQUEST_TEXT = [
  '# Synthetic request',
  '',
  'Question: does the store archive exactly these bytes?',
  'Edge text: 中文、🐉、tabs\tand  double  spaces.',
  '',
].join('\n');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path) => sha256(readFileSync(path));

function syntheticReceipt(overrides = {}) {
  return {
    native_exit_code: 0,
    transport_exit_code: 0,
    transport_status: 'success',
    cleanup: { cleanup_complete: true },
    stdout_truncated: false,
    stderr_truncated: false,
    capture: { stdout_error: null, stderr_error: null, stdin_error: null, launch_error: null },
    ...overrides,
  };
}

function syntheticAcpResult(overrides = {}) {
  return {
    replyText: 'Synthetic reply body.\n',
    stopReason: 'end_turn',
    nativeSessionRef: null,
    continuity: 'new',
    observed: { model: null, thinking: null, source: 'unknown' },
    errorCode: null,
    reviewerProcess: { exitCode: 0, closeReason: 'graceful' },
    ...overrides,
  };
}

async function createFixtureStore(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'acp-mail-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const projectRoot = join(fixtureRoot, 'synthetic-project');
  mkdirSync(projectRoot, { recursive: true });

  const project = await initProject(projectRoot);
  const topic = await createTopic(project.record_root, { title: 'synthetic topic', related_topic_ids: [] });
  const run = await openRun(project.record_root, {
    topic_id: topic.topic_id,
    host_id: SYNTHETIC_SELECTION.host_id,
    host_session_key: 'synthetic-session-key',
    selection: SYNTHETIC_SELECTION,
    route: SYNTHETIC_ROUTE,
  });

  const exchangeId = randomUUID();
  const bytes = Buffer.from(REQUEST_TEXT, 'utf8');

  const f = {
    fixtureRoot,
    projectRoot,
    root: project.record_root,
    projectId: project.project_id,
    topicId: topic.topic_id,
    runId: run.run_id,
    exchangeId,
    bytes,
    jobDir: join(fixtureRoot, 'jobs'),
  };
  mkdirSync(f.jobDir, { recursive: true });

  f.makeInput = (overrides = {}) => ({
    schema_version: 1,
    project_id: f.projectId,
    topic_id: f.topicId,
    run_id: f.runId,
    exchange_id: f.exchangeId,
    previous_exchange_id: null,
    expected_topic_revision: 1,
    attachments: [],
    authorization: {
      ref: 'synthetic-authorization',
      allowed_attachment_hashes: [],
      scope: 'text-and-listed-snapshots',
    },
    ...overrides,
  });
  f.input = f.makeInput();
  return f;
}

// --- worker plumbing -------------------------------------------------------

function startWorker(f, name, job) {
  const jobFile = join(f.jobDir, `${name}.json`);
  writeFileSync(jobFile, JSON.stringify(job, null, 2), 'utf8');
  const child = spawn(process.execPath, [WORKER, jobFile], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { jobFile, resultFile: `${jobFile}.result.json`, child, exited };
}

function workerResult(handle) {
  assert.ok(existsSync(handle.resultFile), `worker left no result at ${handle.resultFile}`);
  return JSON.parse(readFileSync(handle.resultFile, 'utf8'));
}

async function waitForFile(path, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function promptAdmissions(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// M01 - one delivery id, one letter
// ---------------------------------------------------------------------------

test('M01 one delivery id archives once and never rewrites the letter', async (t) => {
  const f = await createFixtureStore(t);

  const first = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  const again = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);

  assert.equal(first.existing, false, 'the first call archives');
  assert.equal(again.existing, true, 'the second call reads the state already on disk');
  assert.equal(first.inputHash, again.inputHash, 'the same content must hash the same way');
  assert.equal(first.exchangeDir, again.exchangeDir);

  await assert.rejects(
    () => prepareExchange(f.root, f.runId, f.exchangeId, Buffer.from('different request'), f.input),
    (error) => ['exchange-id-conflict', 'request-hash-mismatch'].includes(error.code),
    'the same id with different bytes is a conflict',
  );

  const archived = readFileSync(join(first.exchangeDir, 'request.md'));
  assert.deepEqual(archived, f.bytes, 'the archived request is byte for byte what was handed in');

  // Two archives of the same letter in two different runs must still hash the
  // same way: no timestamp and no temporary path may leak into the content.
  const otherRun = await openRun(f.root, {
    topic_id: f.topicId,
    host_id: SYNTHETIC_SELECTION.host_id,
    host_session_key: 'synthetic-session-key-2',
    selection: SYNTHETIC_SELECTION,
    route: SYNTHETIC_ROUTE,
  });
  const elsewhere = await prepareExchange(
    f.root,
    otherRun.run_id,
    f.exchangeId,
    f.bytes,
    f.makeInput({ run_id: otherRun.run_id }),
  );
  assert.equal(
    fileSha(join(elsewhere.exchangeDir, 'outbound.json')),
    fileSha(join(first.exchangeDir, 'outbound.json')),
    'equivalent content must produce an identical outbound document',
  );
});

test('M01 an interrupted archive is not mistaken for an archived letter', async (t) => {
  const f = await createFixtureStore(t);
  await assert.rejects(
    () => prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input, { faultPoints: ['request'] }),
    (error) => error.code === 'store-fault-injected',
  );
  await assert.rejects(
    () => prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input),
    (error) => error.code === 'exchange-archive-incomplete',
    'a half written exchange must be recovered, not silently reused',
  );
});

test('M01 a byte order mark is kept in the archive and left out of what is sent', async (t) => {
  const f = await createFixtureStore(t);
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(REQUEST_TEXT, 'utf8')]);

  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, withBom, f.input);
  assert.deepEqual(
    readFileSync(join(prepared.exchangeDir, 'request.md')),
    withBom,
    'the archive holds the bytes that were handed in, mark and all',
  );

  const outbound = JSON.parse(readFileSync(join(prepared.exchangeDir, 'outbound.json'), 'utf8'));
  assert.equal(outbound.content_blocks[0].text.startsWith('\uFEFF'), false, 'the mark is not sent as text');
  assert.equal(outbound.content_blocks[0].text, REQUEST_TEXT);
});

test('M01 text that is not valid UTF-8 is refused before anything is created', async (t) => {
  const f = await createFixtureStore(t);
  const broken = Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x21]);

  await assert.rejects(
    () => prepareExchange(f.root, f.runId, f.exchangeId, broken, f.input),
    (error) => error.code === 'invalid-utf8',
  );
  assert.equal(
    existsSync(join(f.root, 'topics', f.topicId, 'runs', f.runId, 'exchanges', f.exchangeId)),
    false,
    'a refused request leaves no directory behind',
  );
});

test('M01 identifiers are checked, and a title never becomes a path', async (t) => {
  const f = await createFixtureStore(t);

  for (const badId of ['not-a-uuid', '../escape', 'C:\\absolute', '']) {
    await assert.rejects(
      () => prepareExchange(f.root, f.runId, badId, f.bytes, f.input),
      (error) => error.code === 'invalid-id',
      `${JSON.stringify(badId)} must not be accepted as a delivery id`,
    );
  }

  const awkward = await createTopic(f.root, { title: '../../etc/passwd | a title with | pipes\nand a newline', related_topic_ids: [] });
  assert.match(awkward.topic_id, /^[0-9a-f-]{36}$/, 'the folder name is a generated id, never the title');
  assert.ok(existsSync(join(f.root, 'topics', awkward.topic_id, 'topic.json')));

  const entry = (readIndex(f.root) ?? []).find((e) => e.topic_id === awkward.topic_id);
  assert.ok(entry, 'the awkward title did not break the index');
  assert.equal(entry.relative_path, `topics/${awkward.topic_id}`);
});

test('M01 a record root that must not be used is refused, never redirected', async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'acp-mail-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const projectRoot = join(fixtureRoot, 'tracked-project');
  mkdirSync(projectRoot, { recursive: true });

  // Synthetic Git answers: the decision being tested is what the store does
  // with each answer, not whether Git reports correctly.
  await assert.rejects(
    () => initProject(projectRoot, { gitProbe: () => ({ repository: true, tracked: true }) }),
    (error) => error.code === 'record-root-git-tracked',
  );
  await assert.rejects(
    () => initProject(projectRoot, { gitProbe: () => ({ repository: true, tracked: null }) }),
    (error) => error.code === 'git-status-unknown',
    'an answer that could not be established is a refusal, not a guess',
  );
  assert.equal(
    existsSync(join(projectRoot, '.review-collaboration')),
    false,
    'nothing was written here, and nothing was written anywhere else instead',
  );

  await assert.rejects(
    () => initProject(join(fixtureRoot, 'this-project-does-not-exist')),
    (error) => error.code === 'record-root-unavailable',
  );

  const ok = await initProject(projectRoot, { gitProbe: () => ({ repository: false, tracked: false }) });
  assert.equal(ok.created, true, 'a project outside Git is created normally');
});

// ---------------------------------------------------------------------------
// M02 - a changed source document does not reach back into a sent letter
// ---------------------------------------------------------------------------

test('M02 a later edit to the source document leaves the archived letter alone', async (t) => {
  const f = await createFixtureStore(t);

  const sourceFile = join(f.projectRoot, 'plan.md');
  const firstVersion = Buffer.from('# Plan\n\nFirst version of the premise.\n', 'utf8');
  writeFileSync(sourceFile, firstVersion);
  const firstHash = sha256(firstVersion);

  const prepared = await prepareExchange(
    f.root,
    f.runId,
    f.exchangeId,
    f.bytes,
    f.makeInput({
      attachments: [{ source_file: sourceFile, sha256: firstHash, source_revision: 'plan-rev-1' }],
      authorization: {
        ref: 'synthetic-authorization',
        allowed_attachment_hashes: [firstHash],
        scope: 'text-and-listed-snapshots',
      },
    }),
  );

  const snapshotPath = join(prepared.exchangeDir, 'attachments', firstHash);
  assert.ok(existsSync(snapshotPath), 'the authorized excerpt is archived by content hash');
  const outboundBefore = fileSha(join(prepared.exchangeDir, 'outbound.json'));
  const inputBefore = readArchivedInput(prepared.exchangeDir);

  writeFileSync(sourceFile, Buffer.from('# Plan\n\nSecond version, premise changed.\n', 'utf8'));

  assert.deepEqual(readFileSync(snapshotPath), firstVersion, 'the snapshot keeps the version that was sent');
  assert.equal(fileSha(join(prepared.exchangeDir, 'outbound.json')), outboundBefore, 'the outbound document is unchanged');
  assert.deepEqual(readArchivedInput(prepared.exchangeDir), inputBefore, 'the archived input is unchanged');
  assert.equal(inputBefore.attachments[0].sha256, firstHash);
  assert.equal(inputBefore.attachments[0].source_revision, 'plan-rev-1');
  assert.equal(
    inputBefore.attachments[0].relative_path,
    `attachments/${firstHash}`,
    'the record points at its own archived copy, not at the local source path',
  );
  assert.equal(
    JSON.stringify(inputBefore).includes(sourceFile.replace(/\\/g, '\\\\')),
    false,
    'the local source path is not written into the archived input',
  );

  // The new version has to travel as a new letter, and reusing the old id is a
  // conflict rather than a quiet substitution of evidence.
  const secondBytes = readFileSync(sourceFile);
  const secondHash = sha256(secondBytes);
  await assert.rejects(
    () =>
      prepareExchange(
        f.root,
        f.runId,
        f.exchangeId,
        f.bytes,
        f.makeInput({
          attachments: [{ source_file: sourceFile, sha256: secondHash, source_revision: 'plan-rev-2' }],
          authorization: {
            ref: 'synthetic-authorization',
            allowed_attachment_hashes: [secondHash],
            scope: 'text-and-listed-snapshots',
          },
        }),
      ),
    (error) => error.code === 'exchange-id-conflict',
  );

  const secondExchangeId = randomUUID();
  const second = await prepareExchange(
    f.root,
    f.runId,
    secondExchangeId,
    f.bytes,
    f.makeInput({
      exchange_id: secondExchangeId,
      attachments: [{ source_file: sourceFile, sha256: secondHash, source_revision: 'plan-rev-2' }],
      authorization: {
        ref: 'synthetic-authorization',
        allowed_attachment_hashes: [secondHash],
        scope: 'text-and-listed-snapshots',
      },
    }),
  );
  assert.notEqual(second.inputHash, prepared.inputHash, 'a new premise is a new letter with its own hash');
  assert.deepEqual(readFileSync(snapshotPath), firstVersion, 'the older letter is still exactly as it was sent');
});

// ---------------------------------------------------------------------------
// M03 - a forced failure at each save stage
// ---------------------------------------------------------------------------

test('M03 a forced failure at any save stage leaves the archive untouched and unfinished', async (t) => {
  const stages = ['request', 'partial', 'reply', 'completion'];

  for (const stage of stages) {
    const f = await createFixtureStore(t);

    if (stage === 'request') {
      await assert.rejects(
        () => prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input, { faultPoints: ['request'] }),
        (error) => error.code === 'store-fault-injected',
      );
      const exchangeDir = join(f.root, 'topics', f.topicId, 'runs', f.runId, 'exchanges', f.exchangeId);
      assert.equal(existsSync(join(exchangeDir, 'state.json')), false, 'an interrupted archive is not a finished one');
      assert.equal(existsSync(join(exchangeDir, 'completion.json')), false);

      const recovered = await recoverExchange(exchangeDir);
      assert.equal(recovered.stage, 'archive-incomplete', 'recovery can tell an interrupted archive apart');
      assert.deepEqual(recovered.problems, ['archive-incomplete']);
      continue;
    }

    const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
    await markDelivering(prepared.exchangeDir);
    const requestBefore = fileSha(join(prepared.exchangeDir, 'request.md'));
    const inputBefore = fileSha(join(prepared.exchangeDir, 'input.json'));
    const outboundBefore = fileSha(join(prepared.exchangeDir, 'outbound.json'));

    const result = syntheticAcpResult();

    if (stage === 'partial') {
      await assert.rejects(
        () => savePartialReply(prepared.exchangeDir, 'half a reply', { faultPoints: ['partial'] }),
        (error) => error.code === 'store-fault-injected',
      );
    } else if (stage === 'reply') {
      await savePartialReply(prepared.exchangeDir, 'half a reply');
      await assert.rejects(
        () => saveReply(prepared.exchangeDir, result, { faultPoints: ['reply'] }),
        (error) => error.code === 'store-fault-injected',
      );
      assert.equal(
        existsSync(join(prepared.exchangeDir, 'agent-result.json')),
        false,
        'reply: the interrupted save left no agent result',
      );
    } else {
      await savePartialReply(prepared.exchangeDir, 'half a reply');
      await saveReply(prepared.exchangeDir, result);
      await assert.rejects(
        () => commitCompletion(prepared.exchangeDir, result, syntheticReceipt(), { faultPoints: ['completion'] }),
        (error) => error.code === 'store-fault-injected',
      );
    }

    assert.equal(fileSha(join(prepared.exchangeDir, 'request.md')), requestBefore, `${stage}: the archived request is unchanged`);
    assert.equal(fileSha(join(prepared.exchangeDir, 'input.json')), inputBefore, `${stage}: the archived input is unchanged`);
    assert.equal(fileSha(join(prepared.exchangeDir, 'outbound.json')), outboundBefore, `${stage}: the outbound document is unchanged`);
    assert.equal(
      existsSync(join(prepared.exchangeDir, 'completion.json')),
      false,
      `${stage}: no completion may exist after an interrupted save`,
    );

    const recovered = await recoverExchange(prepared.exchangeDir);
    assert.notEqual(recovered.status, 'reply-ready', `${stage}: an interrupted exchange is never reply-ready`);
    assert.deepEqual(recovered.problems, stage === 'reply' ? ['agent-result-missing'] : [], `${stage}: hashes remain intact, but a reply without its result is explicitly unconfirmed`);
  }
});

test('M03 a completion is only reply-ready when the outer transport was clean too', async (t) => {
  const clean = await createFixtureStore(t);
  const preparedClean = await prepareExchange(clean.root, clean.runId, clean.exchangeId, clean.bytes, clean.input);
  await markDelivering(preparedClean.exchangeDir);
  await saveReply(preparedClean.exchangeDir, syntheticAcpResult());
  const good = await commitCompletion(preparedClean.exchangeDir, syntheticAcpResult(), syntheticReceipt());
  assert.equal(good.status, 'reply-ready');
  assert.equal(good.delivery, 'replied');
  assert.equal(good.semantic_acceptance, 'pending', 'the tool never accepts the review on the main agent behalf');

  // One field at a time: each of these must stop a reply-ready verdict.
  const badReceipts = [
    ['a survivor process was left behind', { cleanup: { cleanup_complete: false } }],
    ['the helper exited nonzero', { native_exit_code: 1 }],
    ['the wrapper exited nonzero', { transport_exit_code: 3 }],
    ['output was truncated', { stdout_truncated: true }],
    ['a capture error was recorded', { capture: { stdout_error: 'synthetic', stderr_error: null, stdin_error: null, launch_error: null } }],
    ['the timeout field is absent', { transport_status: 'timeout' }],
  ];

  for (const [label, overrides] of badReceipts) {
    const f = await createFixtureStore(t);
    const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
    await markDelivering(prepared.exchangeDir);
    await saveReply(prepared.exchangeDir, syntheticAcpResult());
    const completion = await commitCompletion(prepared.exchangeDir, syntheticAcpResult(), syntheticReceipt(overrides));
    assert.equal(completion.status, 'failed', `${label}: must not be reply-ready`);
    assert.equal(completion.delivery, 'replied', `${label}: the reply that did arrive is still recorded`);
    assert.ok(completion.error_code && completion.error_code.length > 0, `${label}: the problem is named`);
  }

  // A receipt that never arrived is missing evidence, not proof of failure.
  const pending = await createFixtureStore(t);
  const preparedPending = await prepareExchange(pending.root, pending.runId, pending.exchangeId, pending.bytes, pending.input);
  await markDelivering(preparedPending.exchangeDir);
  await saveReply(preparedPending.exchangeDir, syntheticAcpResult());
  const recovered = await recoverExchange(preparedPending.exchangeDir);
  assert.equal(recovered.status, 'unconfirmed', 'a saved reply with no completion is still in progress');
  assert.equal(recovered.stage, 'reply-saved-awaiting-completion');
});

test('M03 a stop reason other than end_turn keeps its own meaning', async (t) => {
  const cases = [
    ['refusal', 'refused'],
    ['cancelled', 'cancelled'],
    ['max_tokens', 'incomplete'],
  ];
  for (const [stopReason, expected] of cases) {
    const f = await createFixtureStore(t);
    const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
    await markDelivering(prepared.exchangeDir);
    const result = syntheticAcpResult({ stopReason });
    await saveReply(prepared.exchangeDir, result);
    const completion = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
    assert.equal(completion.status, expected, `${stopReason} must be recorded as ${expected}`);
    assert.equal(completion.acp_stop_reason, stopReason);
  }
});

test('M03 a completion refuses to certify an archive that no longer matches its record', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  await saveReply(prepared.exchangeDir, syntheticAcpResult());

  // The letter is edited between the reply arriving and the completion being
  // published. The completion has to notice, not certify what it summarises.
  appendFileSync(join(prepared.exchangeDir, 'request.md'), 'edited after archiving\n', 'utf8');
  const completion = await commitCompletion(prepared.exchangeDir, syntheticAcpResult(), syntheticReceipt());
  assert.equal(completion.status, 'failed', 'a changed archive can never be reply-ready');
  assert.ok(
    completion.error_code.includes('hash-mismatch'),
    `the mismatch must be named, got: ${completion.error_code}`,
  );
});

test('M03 an edited reply stops the record from reading as verified', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  await saveReply(prepared.exchangeDir, syntheticAcpResult());
  await commitCompletion(prepared.exchangeDir, syntheticAcpResult(), syntheticReceipt());

  appendFileSync(join(prepared.exchangeDir, 'reply.md'), 'tampered line\n', 'utf8');
  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.stage, 'completion-unverified');
  assert.ok(recovered.problems.includes('reply-hash-mismatch'));
});

// ---------------------------------------------------------------------------
// M04 - being able to read a file is not permission to send it
// ---------------------------------------------------------------------------

test('M04 only listed and authorized material is archived for sending', async (t) => {
  const f = await createFixtureStore(t);

  const readable = join(f.projectRoot, 'readable-but-unauthorized.md');
  writeFileSync(readable, 'Local notes nobody authorized.\n', 'utf8');
  const readableHash = sha256(readFileSync(readable));

  await assert.rejects(
    () =>
      prepareExchange(
        f.root,
        f.runId,
        f.exchangeId,
        f.bytes,
        f.makeInput({ attachments: [{ source_file: readable, sha256: readableHash, source_revision: 'r1' }] }),
      ),
    (error) => error.code === 'attachment-not-authorized',
    'a file this machine can read is not thereby sendable',
  );

  // A refused letter leaves nothing behind, so its delivery id is still free.
  assert.equal(
    existsSync(join(f.root, 'topics', f.topicId, 'runs', f.runId, 'exchanges', f.exchangeId)),
    false,
    'a request refused before archiving creates no directory and does not use up its id',
  );

  const authorized = join(f.projectRoot, 'authorized.md');
  writeFileSync(authorized, 'Authorized excerpt.\n', 'utf8');
  const authorizedHash = sha256(readFileSync(authorized));
  await assert.rejects(
    () =>
      prepareExchange(
        f.root,
        f.runId,
        f.exchangeId,
        f.bytes,
        f.makeInput({
          attachments: [{ source_file: authorized, sha256: 'a'.repeat(64), source_revision: 'r1' }],
          authorization: {
            ref: 'synthetic-authorization',
            allowed_attachment_hashes: [authorizedHash],
            scope: 'text-and-listed-snapshots',
          },
        }),
      ),
    (error) => error.code === 'attachment-hash-mismatch',
    'a declared hash that does not match the bytes is refused',
  );

  // Another topic's archived letter is on this disk and is still not sendable.
  const otherTopic = await createTopic(f.root, { title: 'another topic', related_topic_ids: [] });
  const otherRun = await openRun(f.root, {
    topic_id: otherTopic.topic_id,
    host_id: SYNTHETIC_SELECTION.host_id,
    host_session_key: 'other-session-key',
    selection: SYNTHETIC_SELECTION,
    route: SYNTHETIC_ROUTE,
  });
  const otherExchangeId = randomUUID();
  const otherPrepared = await prepareExchange(
    f.root,
    otherRun.run_id,
    otherExchangeId,
    Buffer.from('A letter that belongs to another topic.\n', 'utf8'),
    f.makeInput({ topic_id: otherTopic.topic_id, run_id: otherRun.run_id, exchange_id: otherExchangeId }),
  );
  const otherLetter = join(otherPrepared.exchangeDir, 'request.md');
  assert.ok(existsSync(otherLetter), 'the other letter really is readable locally');

  await assert.rejects(
    () =>
      prepareExchange(
        f.root,
        f.runId,
        f.exchangeId,
        f.bytes,
        f.makeInput({ attachments: [{ source_file: otherLetter, source_revision: 'r1' }] }),
      ),
    (error) => error.code === 'attachment-not-authorized',
    'another exchange letter is not attached just because it is on this disk',
  );

  // A draft whose ids point at a different topic than the run does is refused
  // before anything is archived.
  await assert.rejects(
    () => prepareExchange(f.root, f.runId, randomUUID(), f.bytes, f.makeInput({ topic_id: otherTopic.topic_id })),
    (error) => ['invalid-input', 'run-topic-mismatch'].includes(error.code),
  );

  const authorizedDraftId = randomUUID();
  const ok = await prepareExchange(
    f.root,
    f.runId,
    authorizedDraftId,
    f.bytes,
    f.makeInput({
      exchange_id: authorizedDraftId,
      attachments: [{ source_file: authorized, sha256: authorizedHash, source_revision: 'r1' }],
      authorization: {
        ref: 'synthetic-authorization',
        allowed_attachment_hashes: [authorizedHash],
        scope: 'text-and-listed-snapshots',
      },
    }),
  );
  const outbound = JSON.parse(readFileSync(join(ok.exchangeDir, 'outbound.json'), 'utf8'));
  assert.equal(outbound.content_blocks.length, 2, 'the outbound document holds the body and the one authorized excerpt');
  assert.equal(
    outbound.content_blocks.some((b) => b.text.includes('Local notes nobody authorized')),
    false,
    'nothing unauthorized found its way into what would be sent',
  );
  assert.equal(
    readdirSync(join(ok.exchangeDir, 'attachments')).length,
    1,
    'exactly one snapshot was archived',
  );
});

// ---------------------------------------------------------------------------
// M05 - two projects with the same name are two projects
// ---------------------------------------------------------------------------

test('M05 same-named projects get their own identity and never share records', async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'acp-mail-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const roots = ['workspace-a', 'workspace-b'].map((parent) => {
    const dir = join(fixtureRoot, parent, 'project');
    mkdirSync(dir, { recursive: true });
    return dir;
  });

  const [a, b] = await Promise.all(roots.map((root) => initProject(root)));
  assert.notEqual(a.project_id, b.project_id, 'a project id is not derived from the folder name');
  assert.notEqual(a.record_root, b.record_root);
  assert.equal(readFileSync(join(a.record_root, '.gitignore'), 'utf8'), '*\n');

  const topicA = await createTopic(a.record_root, { title: 'shared title', related_topic_ids: [] });
  const topicB = await createTopic(b.record_root, { title: 'shared title', related_topic_ids: [] });
  assert.notEqual(topicA.topic_id, topicB.topic_id);

  await assert.rejects(
    () => locateTopic(a.record_root, topicB.topic_id),
    (error) => error.code === 'topic-not-found',
    'one project cannot look up the other project topics',
  );

  const second = await initProject(roots[0]);
  assert.equal(second.created, false, 'a second init reads the existing identity');
  assert.equal(second.project_id, a.project_id, 'the project id is stable');
});

// ---------------------------------------------------------------------------
// M06 - records that can move
// ---------------------------------------------------------------------------

test('M06 a moved record folder is still readable from the topic id alone', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  await saveReply(prepared.exchangeDir, syntheticAcpResult());
  await commitCompletion(prepared.exchangeDir, syntheticAcpResult(), syntheticReceipt());
  const letterHash = fileSha(join(prepared.exchangeDir, 'request.md'));

  const movedProjectRoot = join(f.fixtureRoot, 'relocated', 'elsewhere');
  mkdirSync(movedProjectRoot, { recursive: true });
  const movedRoot = join(movedProjectRoot, '.review-collaboration');
  cpSync(f.root, movedRoot, { recursive: true });

  // A fresh host knows the topic id and nothing else.
  const located = await locateTopic(movedRoot, f.topicId);
  assert.equal(located.relative_path, `topics/${f.topicId}`, 'the index answers with a relative path');
  assert.equal(
    existsSync(join(movedRoot, located.relative_path, 'runs', f.runId, 'exchanges', f.exchangeId, 'request.md')),
    true,
  );
  assert.equal(
    fileSha(join(movedRoot, located.relative_path, 'runs', f.runId, 'exchanges', f.exchangeId, 'request.md')),
    letterHash,
    'the moved letter is byte for byte the one that was sent',
  );
  assert.equal(readProject(movedRoot).project_id, f.projectId, 'moving the folder does not change which project it is');

  const recovered = await recoverExchange(
    join(movedRoot, located.relative_path, 'runs', f.runId, 'exchanges', f.exchangeId),
  );
  assert.equal(recovered.status, 'reply-ready', 'the completion still verifies after the move');
  assert.deepEqual(recovered.problems, []);

  // The route snapshot keeps the absolute path recorded on the old machine. It
  // is kept for the record and must be resolved again in T3; nothing here
  // claims it still points at a working reviewer.
  const run = JSON.parse(readFileSync(join(movedRoot, located.relative_path, 'runs', f.runId, 'run.json'), 'utf8'));
  assert.equal(run.route.launch.executable, SYNTHETIC_ROUTE.launch.executable);
  assert.equal(run.route.verification.level, 'discovered', 'a stored route is not a verified route');
});

test('M06 a lost index is rebuilt from the topics themselves', async (t) => {
  const f = await createFixtureStore(t);
  const second = await createTopic(f.root, { title: 'second topic', related_topic_ids: [] });
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  const letterHash = fileSha(join(prepared.exchangeDir, 'request.md'));

  rmSync(join(f.root, 'index.md'), { force: true });
  const located = await locateTopic(f.root, second.topic_id);
  assert.equal(located.topic_id, second.topic_id);

  const entries = readIndex(f.root);
  assert.equal(entries.length, 2, 'both topics come back');
  assert.equal(fileSha(join(prepared.exchangeDir, 'request.md')), letterHash, 'the letters were never touched');
});

// ---------------------------------------------------------------------------
// C01 - one run, one turn in flight
// ---------------------------------------------------------------------------

test('C01 two processes on one run: one proceeds, the other is told the run is busy', async (t) => {
  const f = await createFixtureStore(t);
  const promptLogFile = join(f.fixtureRoot, 'prompt-admissions.log');

  // Both letters are archived first, so the test can show that losing the race
  // costs the loser nothing.
  const exchangeA = f.exchangeId;
  const exchangeB = randomUUID();
  const a = await prepareExchange(f.root, f.runId, exchangeA, f.bytes, f.makeInput({ exchange_id: exchangeA }));
  const b = await prepareExchange(f.root, f.runId, exchangeB, f.bytes, f.makeInput({ exchange_id: exchangeB }));
  const draftBHash = fileSha(join(b.exchangeDir, 'request.md'));

  const startAtMs = Date.now() + 400;
  const jobs = [
    startWorker(f, 'c01-a', {
      op: 'try-lock',
      recordRoot: f.root,
      runId: f.runId,
      exchangeId: exchangeA,
      promptLogFile,
      holdMs: 1200,
      startAtMs,
    }),
    startWorker(f, 'c01-b', {
      op: 'try-lock',
      recordRoot: f.root,
      runId: f.runId,
      exchangeId: exchangeB,
      promptLogFile,
      holdMs: 1200,
      startAtMs,
    }),
  ];
  await Promise.all(jobs.map((j) => j.exited));

  const results = jobs.map(workerResult);
  const acquired = results.filter((r) => r.acquired === true);
  const busy = results.filter((r) => r.acquired === false);
  assert.equal(acquired.length, 1, 'exactly one process may hold the run');
  assert.equal(busy.length, 1, 'the other is refused');
  assert.equal(busy[0].code, 'run-busy');
  assert.notEqual(acquired[0].pid, busy[0].pid, 'these really were two operating system processes');

  assert.equal(promptAdmissions(promptLogFile).length, 1, 'only one turn reached the sending step');

  assert.equal(fileSha(join(b.exchangeDir, 'request.md')), draftBHash, 'the refused caller keeps its archived draft');
  assert.equal(existsSync(join(a.exchangeDir, 'completion.json')), false);
  assert.equal(existsSync(join(b.exchangeDir, 'completion.json')), false);

  // The lock is gone once its owner finished, so the run is usable again.
  const after = await withRunLock(f.root, f.runId, async () => 'free');
  assert.equal(after, 'free');
});

// ---------------------------------------------------------------------------
// C02 - separate runs pair by identity, not by who finished first
// ---------------------------------------------------------------------------

test('C02 two runs finishing out of order still pair each reply with its own letter', async (t) => {
  const f = await createFixtureStore(t);
  const promptLogFile = join(f.fixtureRoot, 'prompt-admissions.log');

  const topicTwo = await createTopic(f.root, { title: 'second topic', related_topic_ids: [] });
  const runTwo = await openRun(f.root, {
    topic_id: topicTwo.topic_id,
    host_id: SYNTHETIC_SELECTION.host_id,
    host_session_key: 'synthetic-session-key-2',
    selection: SYNTHETIC_SELECTION,
    route: SYNTHETIC_ROUTE,
  });

  const slowId = randomUUID();
  const fastId = randomUUID();
  const startAtMs = Date.now() + 400;

  // The slow one was started first and is deliberately finished last.
  const slow = startWorker(f, 'c02-slow', {
    op: 'exchange-turn',
    recordRoot: f.root,
    runId: f.runId,
    exchangeId: slowId,
    requestText: 'Letter for the first run.\n',
    input: f.makeInput({ exchange_id: slowId }),
    agentResult: syntheticAcpResult({ replyText: 'Reply that belongs to the first run.\n' }),
    receipt: syntheticReceipt(),
    replyDelayMs: 1500,
    promptLogFile,
    startAtMs,
  });
  const fast = startWorker(f, 'c02-fast', {
    op: 'exchange-turn',
    recordRoot: f.root,
    runId: runTwo.run_id,
    exchangeId: fastId,
    requestText: 'Letter for the second run.\n',
    input: f.makeInput({ topic_id: topicTwo.topic_id, run_id: runTwo.run_id, exchange_id: fastId }),
    agentResult: syntheticAcpResult({ replyText: 'Reply that belongs to the second run.\n' }),
    receipt: syntheticReceipt(),
    replyDelayMs: 0,
    promptLogFile,
    startAtMs,
  });

  await Promise.all([slow.exited, fast.exited]);
  const slowResult = workerResult(slow);
  const fastResult = workerResult(fast);
  assert.equal(slowResult.ok, true, `slow run failed: ${slowResult.message ?? ''}`);
  assert.equal(fastResult.ok, true, `fast run failed: ${fastResult.message ?? ''}`);
  assert.equal(promptAdmissions(promptLogFile).length, 2, 'separate runs are not serialised against each other');

  for (const [result, expectedRun, expectedBody] of [
    [slowResult, f.runId, 'Reply that belongs to the first run.\n'],
    [fastResult, runTwo.run_id, 'Reply that belongs to the second run.\n'],
  ]) {
    const completion = JSON.parse(readFileSync(join(result.exchangeDir, 'completion.json'), 'utf8'));
    assert.equal(completion.run_id, expectedRun);
    assert.equal(completion.status, 'reply-ready');
    assert.equal(completion.input_sha256, result.inputHash, 'the completion names the input it answers');
    assert.equal(completion.input_sha256, fileSha(join(result.exchangeDir, 'input.json')));
    assert.equal(completion.reply_sha256, fileSha(join(result.exchangeDir, 'reply.md')));
    assert.equal(readFileSync(join(result.exchangeDir, 'reply.md'), 'utf8'), expectedBody);
  }

  assert.notEqual(slowResult.completion.exchange_id, fastResult.completion.exchange_id);
  assert.notEqual(slowResult.completion.reply_sha256, fastResult.completion.reply_sha256);
});

// ---------------------------------------------------------------------------
// C03 - two writers touching the index at once
// ---------------------------------------------------------------------------

test('C03 two processes creating topics at once both survive in the index', async (t) => {
  const f = await createFixtureStore(t);
  const startAtMs = Date.now() + 400;

  const workers = ['c03-one', 'c03-two'].map((name, i) =>
    startWorker(f, name, { op: 'create-topic', recordRoot: f.root, title: `concurrent topic ${i}`, startAtMs }),
  );
  await Promise.all(workers.map((w) => w.exited));
  const created = workers.map(workerResult);
  for (const result of created) assert.ok(result.topic_id, `worker reported no topic: ${result.message ?? ''}`);

  const entries = readIndex(f.root);
  const ids = new Set(entries.map((e) => e.topic_id));
  for (const result of created) assert.ok(ids.has(result.topic_id), `topic ${result.topic_id} is missing from the index`);
  assert.equal(entries.length, 3, 'the fixture topic and both new ones are all listed');

  // A damaged index costs nothing, because the topics themselves are the truth.
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  const letterHash = fileSha(join(prepared.exchangeDir, 'request.md'));
  writeFileSync(join(f.root, 'index.md'), 'this file is damaged\n', 'utf8');

  const rebuilt = await rebuildIndex(f.root);
  assert.equal(rebuilt.length, 3, 'every topic comes back');
  for (const result of created) assert.ok(rebuilt.some((e) => e.topic_id === result.topic_id));
  assert.equal(fileSha(join(prepared.exchangeDir, 'request.md')), letterHash, 'the letters were untouched throughout');
});

// ---------------------------------------------------------------------------
// C04 - who owns a lock, and when it may be taken back
// ---------------------------------------------------------------------------

test('C04 a lock held by a living process is never taken, however long it waits', async (t) => {
  const f = await createFixtureStore(t);
  const promptLogFile = join(f.fixtureRoot, 'prompt-admissions.log');
  const readyFile = join(f.fixtureRoot, 'holder-ready');

  const holder = startWorker(f, 'c04-holder', {
    op: 'hold-lock',
    recordRoot: f.root,
    runId: f.runId,
    readyFile,
    releaseFile: join(f.fixtureRoot, 'holder-release'),
  });
  await waitForFile(readyFile);

  await assert.rejects(
    () => withRunLock(f.root, f.runId, async () => 'should not run'),
    (error) => error.code === 'run-busy',
    'a second caller is refused while the first still holds the run',
  );

  const first = await recoverRun(f.root, f.runId);
  assert.equal(first.lock_present, true);
  assert.equal(first.released, false);
  assert.equal(first.reason, 'lock-owner-alive');

  // Waiting longer does not turn a live owner into a dead one.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const later = await recoverRun(f.root, f.runId);
  assert.equal(later.released, false, 'age is not evidence that an owner is gone');
  assert.equal(later.reason, 'lock-owner-alive');
  assert.equal(later.owner.pid, Number(readFileSync(readyFile, 'utf8')), 'the recorded owner is the real holder');

  writeFileSync(join(f.fixtureRoot, 'holder-release'), 'release');
  assert.equal(await holder.exited, 0);
  assert.equal(promptAdmissions(promptLogFile).length, 0, 'recovery never reaches the sending step');

  const afterRelease = await recoverRun(f.root, f.runId);
  assert.equal(afterRelease.lock_present, false, 'the owner released its own lock on the way out');
});

test('C04 a lock whose owner is provably gone is cleared, and only then', async (t) => {
  const f = await createFixtureStore(t);
  const readyFile = join(f.fixtureRoot, 'abandon-ready');
  const lockPath = join(f.root, 'topics', f.topicId, 'runs', f.runId, 'run.lock');

  const abandoner = startWorker(f, 'c04-abandon', {
    op: 'abandon-lock',
    recordRoot: f.root,
    runId: f.runId,
    readyFile,
  });
  assert.equal(await abandoner.exited, 0);
  assert.ok(existsSync(lockPath), 'the dead process really did leave its lock behind');

  const recovered = await recoverRun(f.root, f.runId);
  assert.equal(recovered.released, true);
  assert.equal(recovered.reason, 'owner-process-not-found');
  assert.equal(existsSync(lockPath), false);

  const reused = await withRunLock(f.root, f.runId, async () => 'usable again');
  assert.equal(reused, 'usable again');
});

test('C04 a reused process id is not an owner, and an unreadable identity is not a licence', async (t) => {
  const f = await createFixtureStore(t);
  const lockPath = join(f.root, 'topics', f.topicId, 'runs', f.runId, 'run.lock');

  // Synthetic: this process is alive under this pid, but it is not the process
  // that wrote the lock, because the start time does not match. That is what a
  // reused process id looks like from the outside.
  const stale = {
    schema_version: 1,
    owner_nonce: randomUUID(),
    pid: process.pid,
    process_start_time_ms: 1,
    host: 'synthetic-host',
    acquired_at: new Date(0).toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(stale, null, 2), 'utf8');
  const reused = await recoverRun(f.root, f.runId);
  assert.equal(reused.released, true);
  assert.equal(reused.reason, 'owner-pid-reused');

  // Synthetic: the identity of the owner cannot be read at all. Nothing is
  // reclaimed, because not knowing is not the same as knowing it is dead.
  writeFileSync(lockPath, JSON.stringify({ ...stale, process_start_time_ms: 999 }, null, 2), 'utf8');
  const unknown = await recoverRun(f.root, f.runId, { identityProbe: () => ({ state: 'unknown', start_time_ms: null }) });
  assert.equal(unknown.released, false);
  assert.equal(unknown.reason, 'lock-owner-unknown');
  assert.ok(existsSync(lockPath), 'an unreadable identity leaves the lock in place');

  // A lock that records no start time cannot be checked either.
  writeFileSync(lockPath, JSON.stringify({ ...stale, process_start_time_ms: null }, null, 2), 'utf8');
  const noStart = await recoverRun(f.root, f.runId);
  assert.equal(noStart.released, false);
  assert.equal(noStart.reason, 'lock-owner-unknown');

  // Releasing checks ownership again: a lock that now belongs to someone else
  // is left where it is.
  assert.throws(
    () => releaseRunLock(lockPath, 'a-nonce-that-never-owned-this-lock'),
    (error) => error.code === 'lock-ownership-changed',
  );
  assert.ok(existsSync(lockPath), 'another owner lock is never deleted');
});

test('C04 reading state and recovering never reach the sending step', async (t) => {
  const f = await createFixtureStore(t);
  const promptLogFile = join(f.fixtureRoot, 'prompt-admissions.log');
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);

  const state = readExchangeState(prepared.exchangeDir);
  assert.equal(state.delivery, 'unknown', 'a prompt about to go out is recorded as unknown, not as unsent');

  const recoveredExchange = await recoverExchange(prepared.exchangeDir);
  assert.equal(recoveredExchange.delivery, 'unknown');
  assert.equal(recoveredExchange.status, 'unconfirmed', 'an interrupted delivery stays unconfirmed, not failed');

  const recoveredRun = await recoverRun(f.root, f.runId);
  assert.equal(recoveredRun.lock_present, false);
  assert.equal(promptAdmissions(promptLogFile).length, 0, 'status and recovery sent nothing');
});

// ===========================================================================
// T2-R1: the cases root reproduced against the T2 store.
//
// Each one is written from the root counterexample it came from, not from what
// the implementation happens to do. Group names follow the review: F01 to F06.
// ===========================================================================

const SOURCE_TEXT = 'Authorized excerpt, first version.\n';

// Archives one letter carrying one authorized attachment, and returns
// everything needed to hand in a second draft for the same delivery id.
async function archiveWithAttachment(t) {
  const f = await createFixtureStore(t);
  const sourceFile = join(f.projectRoot, 'source.md');
  writeFileSync(sourceFile, SOURCE_TEXT, 'utf8');
  const hash = sha256(readFileSync(sourceFile));

  const draft = () =>
    f.makeInput({
      attachments: [{ source_file: sourceFile, sha256: hash, source_revision: 'rev-1' }],
      authorization: {
        ref: 'synthetic-authorization',
        allowed_attachment_hashes: [hash],
        scope: 'text-and-listed-snapshots',
      },
    });

  const first = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, draft());
  return { f, sourceFile, hash, draft, first };
}

// ---------------------------------------------------------------------------
// F01 - a repeat delivery must be compared on everything that decides what
//       would be sent, who authorized it and which version it rests on
// ---------------------------------------------------------------------------

test('F01 a second draft that changes what would be sent is a conflict, not a match', async (t) => {
  const { f, hash, draft, first } = await archiveWithAttachment(t);
  const archivedInputBefore = fileSha(join(first.exchangeDir, 'input.json'));
  const archivedOutboundBefore = fileSha(join(first.exchangeDir, 'outbound.json'));
  const archivedRequestBefore = fileSha(join(first.exchangeDir, 'request.md'));
  const snapshotBefore = fileSha(join(first.exchangeDir, 'attachments', hash));

  const variants = [
    ['remove-attachments', () => f.makeInput({ attachments: [] })],
    [
      'revoke-allowed-hash',
      () => {
        const d = draft();
        d.authorization = { ...d.authorization, allowed_attachment_hashes: [] };
        return d;
      },
    ],
    [
      'change-source-revision',
      () => {
        const d = draft();
        d.attachments = [{ ...d.attachments[0], source_revision: 'rev-2' }];
        return d;
      },
    ],
    [
      'wrong-outbound-hash',
      () => {
        const d = draft();
        d.outbound_sha256 = 'b'.repeat(64);
        return d;
      },
    ],
  ];

  for (const [name, build] of variants) {
    await assert.rejects(
      () => prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, build()),
      (error) =>
        ['exchange-id-conflict', 'request-hash-mismatch', 'outbound-hash-mismatch', 'duplicate-draft-incomplete'].includes(
          error.code,
        ),
      `${name}: a draft that differs in what would be sent must be refused`,
    );
  }

  assert.equal(fileSha(join(first.exchangeDir, 'input.json')), archivedInputBefore, 'the archived input is untouched');
  assert.equal(fileSha(join(first.exchangeDir, 'outbound.json')), archivedOutboundBefore, 'the outbound document is untouched');
  assert.equal(fileSha(join(first.exchangeDir, 'request.md')), archivedRequestBefore, 'the archived request is untouched');
  assert.equal(fileSha(join(first.exchangeDir, 'attachments', hash)), snapshotBefore, 'the snapshot is untouched');
  assert.equal(existsSync(join(first.exchangeDir, 'completion.json')), false, 'nothing was resent or completed');
});

test('F01 a genuinely identical second draft still reads back the archived letter', async (t) => {
  const { f, draft, first } = await archiveWithAttachment(t);
  const again = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, draft());
  assert.equal(again.existing, true);
  assert.equal(again.inputHash, first.inputHash);
});

test('F01 a repeat draft that cannot be compared says so instead of matching', async (t) => {
  const { f, draft } = await archiveWithAttachment(t);
  const withoutHash = draft();
  delete withoutHash.attachments[0].sha256;

  await assert.rejects(
    () => prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, withoutHash),
    (error) => error.code === 'duplicate-draft-incomplete',
    'a draft with no attachment hash cannot be declared identical',
  );
});

test('F01 looking up an archived letter still works after the premise moved on', async (t) => {
  const { f, draft, first } = await archiveWithAttachment(t);
  await store.bumpTopicRevision(f.root, f.topicId, 1);

  const again = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, draft());
  assert.equal(again.existing, true, 'an already archived letter is still readable at its own revision');
  assert.equal(again.inputHash, first.inputHash);

  // A new delivery, however, is measured against the revision in force now.
  const freshId = randomUUID();
  await assert.rejects(
    () => prepareExchange(f.root, f.runId, freshId, f.bytes, f.makeInput({ exchange_id: freshId })),
    (error) => error.code === 'topic-revision-mismatch',
    'a new letter must name the revision that is current',
  );
});

test('F01 a tampered archive is never reported as a matching letter', async (t) => {
  const { f, draft, first } = await archiveWithAttachment(t);
  appendFileSync(join(first.exchangeDir, 'request.md'), 'edited behind the record\n', 'utf8');

  await assert.rejects(
    () => prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, draft()),
    (error) => ['archived-evidence-mismatch', 'request-hash-mismatch'].includes(error.code),
    'a changed archive must not answer existing=true',
  );
});

// ---------------------------------------------------------------------------
// F02 - a completion may only describe evidence that is actually on disk
// ---------------------------------------------------------------------------

test('F02 a completion is not reply-ready without the agent result behind it', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);

  const result = syntheticAcpResult();
  await assert.rejects(
    () => saveReply(prepared.exchangeDir, result, { faultPoints: ['reply'] }),
    (error) => error.code === 'store-fault-injected',
  );
  assert.equal(existsSync(join(prepared.exchangeDir, 'agent-result.json')), false, 'the setup really is missing it');

  const completion = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
  assert.notEqual(completion.status, 'reply-ready', 'a caller argument cannot stand in for missing evidence');
  assert.ok(completion.error_code && completion.error_code.includes('agent-result'), `the gap must be named, got: ${completion.error_code}`);
});

test('F02 a caller result that disagrees with the saved one is refused', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);

  const saved = syntheticAcpResult({ stopReason: 'cancelled' });
  await saveReply(prepared.exchangeDir, saved);

  await assert.rejects(
    () => commitCompletion(prepared.exchangeDir, syntheticAcpResult({ stopReason: 'end_turn' }), syntheticReceipt()),
    (error) => error.code === 'agent-result-mismatch',
    'what was saved decides, not what the caller says now',
  );
});

test('F02 reading and re-committing a tampered completion agree with each other', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, result);
  const published = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
  assert.equal(published.status, 'reply-ready');

  appendFileSync(join(prepared.exchangeDir, 'request.md'), 'edited after completion\n', 'utf8');

  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.stage, 'completion-unverified');

  let recommitStatus;
  try {
    recommitStatus = (await commitCompletion(prepared.exchangeDir, result, syntheticReceipt())).status;
  } catch (error) {
    recommitStatus = error.code;
  }
  assert.notEqual(recommitStatus, 'reply-ready', 'the two read paths must not disagree about the same damage');
});

test('F02 a tampered attachment stops the completion from reading as verified', async (t) => {
  const { f, hash, first } = await archiveWithAttachment(t);
  await markDelivering(first.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(first.exchangeDir, result);
  await commitCompletion(first.exchangeDir, result, syntheticReceipt());

  writeFileSync(join(first.exchangeDir, 'attachments', hash), 'replaced evidence\n', 'utf8');

  const recovered = await recoverExchange(first.exchangeDir);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.stage, 'completion-unverified');
  assert.ok(recovered.problems.some((p) => p.includes('attachment')), `the attachment must be named, got: ${JSON.stringify(recovered.problems)}`);
  assert.equal(fileSha(join(first.exchangeDir, 'request.md')), fileSha(join(first.exchangeDir, 'request.md')));
});

test('F02 a completion that points at the wrong exchange is not verified', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, result);
  await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());

  const path = join(prepared.exchangeDir, 'completion.json');
  const completion = JSON.parse(readFileSync(path, 'utf8'));
  completion.project_id = randomUUID();
  completion.exchange_id = randomUUID();
  writeFileSync(path, `${JSON.stringify(completion, null, 2)}\n`, 'utf8');

  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.stage, 'completion-unverified');
  assert.ok(
    recovered.problems.some((p) => p.includes('completion')),
    `the correlation failure must be named, got: ${JSON.stringify(recovered.problems)}`,
  );
});

test('F02 a missing hash in the progress record does not switch the checks off', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, result);

  const statePath = join(prepared.exchangeDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  delete state.request_sha256;
  delete state.input_sha256;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.notEqual(recovered.status, 'reply-ready');
  assert.ok(
    recovered.problems.some((p) => p.includes('missing')),
    `an absent hash is a gap to report, got: ${JSON.stringify(recovered.problems)}`,
  );
});

// ---------------------------------------------------------------------------
// F03 - a stop reason that was actually received keeps its meaning
// ---------------------------------------------------------------------------

test('F03 a reviewer error is never a normal completion', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult({ errorCode: 'synthetic-reviewer-error' });
  await saveReply(prepared.exchangeDir, result);

  const completion = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
  assert.equal(completion.status, 'failed', 'an error and a normal completion cannot both be true');
  assert.ok(completion.error_code.includes('synthetic-reviewer-error'));
  assert.equal(readFileSync(join(prepared.exchangeDir, 'reply.md'), 'utf8'), result.replyText, 'the body that did arrive is kept');
});

test('F03 a confirmed ending with no text keeps its own reason', async (t) => {
  const cases = [
    ['cancelled', 'cancelled'],
    ['refusal', 'refused'],
    ['max_tokens', 'incomplete'],
  ];

  for (const [stopReason, expected] of cases) {
    const f = await createFixtureStore(t);
    const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
    await markDelivering(prepared.exchangeDir);
    const result = syntheticAcpResult({ stopReason, replyText: '' });
    await saveReply(prepared.exchangeDir, result);

    const completion = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
    assert.equal(completion.status, expected, `${stopReason} with no text must stay ${expected}`);
    assert.equal(completion.delivery, 'replied', `${stopReason}: a turn result did come back`);
    assert.equal(completion.acp_stop_reason, stopReason);
  }
});

test('F03 an ending claimed as normal but carrying no text is not reply-ready', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult({ replyText: '' });
  await saveReply(prepared.exchangeDir, result);

  const completion = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
  assert.notEqual(completion.status, 'reply-ready');
});

test('F03 no turn result at all is still unconfirmed, not a confirmed ending', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);

  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.equal(recovered.status, 'unconfirmed');
  assert.equal(recovered.delivery, 'unknown');
});

// ---------------------------------------------------------------------------
// F04 - the premise version changes once, and a short lock can be recovered
// ---------------------------------------------------------------------------

test('F04 two processes raising the premise version: exactly one succeeds', async (t) => {
  const f = await createFixtureStore(t);
  const startAtMs = Date.now() + 500;

  const workers = ['f04-one', 'f04-two'].map((name) =>
    startWorker(f, name, { op: 'bump-revision', recordRoot: f.root, topicId: f.topicId, expectedRevision: 1, startAtMs }),
  );
  await Promise.all(workers.map((w) => w.exited));
  const results = workers.map(workerResult);

  const succeeded = results.filter((r) => r.ok === true);
  const refused = results.filter((r) => r.ok === false);
  assert.equal(succeeded.length, 1, `exactly one update may take effect, got ${JSON.stringify(results)}`);
  assert.equal(refused.length, 1);
  assert.ok(
    ['topic-revision-mismatch', 'topic-busy'].includes(refused[0].code),
    `the loser must be told why, got: ${refused[0].code}`,
  );
  assert.notEqual(succeeded[0].pid, refused[0].pid, 'these really were two processes');

  const topic = JSON.parse(readFileSync(join(f.root, 'topics', f.topicId, 'topic.json'), 'utf8'));
  assert.equal(topic.revision, 2, 'two updates must not quietly merge into one step');
});

test('F04 a short lock left by a dead process can be recovered', async (t) => {
  const f = await createFixtureStore(t);
  const readyFile = join(f.fixtureRoot, 'index-lock-ready');

  const abandoner = startWorker(f, 'f04-index-lock', {
    op: 'abandon-index-lock',
    recordRoot: f.root,
    readyFile,
  });
  assert.equal(await abandoner.exited, 0);
  const lockPath = join(f.root, 'index.lock');
  assert.ok(existsSync(lockPath), 'the dead process really did leave the index lock behind');

  const recovered = await store.recoverStoreLocks(f.root);
  const indexLock = recovered.find((entry) => entry.kind === 'index');
  assert.ok(indexLock, `recovery must cover short locks, got: ${JSON.stringify(recovered)}`);
  assert.equal(indexLock.released, true);
  assert.equal(existsSync(lockPath), false);

  const rebuilt = await rebuildIndex(f.root);
  assert.ok(rebuilt.length >= 1, 'the index is usable again');
});

test('F04 a short lock left behind does not block the next writer forever', async (t) => {
  const f = await createFixtureStore(t);
  const readyFile = join(f.fixtureRoot, 'index-lock-ready-2');
  const abandoner = startWorker(f, 'f04-index-lock-2', { op: 'abandon-index-lock', recordRoot: f.root, readyFile });
  assert.equal(await abandoner.exited, 0);

  const began = Date.now();
  const topic = await createTopic(f.root, { title: 'after a dead index lock', related_topic_ids: [] });
  const elapsed = Date.now() - began;
  assert.ok(topic.topic_id, 'a new topic can still be created');
  assert.ok(elapsed < 20000, `waiting must end once the owner is proved gone, took ${elapsed} ms`);
  assert.ok((readIndex(f.root) ?? []).some((e) => e.topic_id === topic.topic_id));
});

test('F04 a short lock held by a living process is still respected', async (t) => {
  const f = await createFixtureStore(t);
  const readyFile = join(f.fixtureRoot, 'index-lock-held');
  const holder = startWorker(f, 'f04-index-hold', {
    op: 'hold-index-lock',
    recordRoot: f.root,
    readyFile,
    holdMs: 2000,
  });
  await waitForFile(readyFile);

  const decisions = await store.recoverStoreLocks(f.root);
  const indexLock = decisions.find((entry) => entry.kind === 'index');
  assert.ok(indexLock);
  assert.equal(indexLock.released, false, 'a live owner keeps its lock');
  assert.equal(indexLock.reason, 'lock-owner-alive');

  assert.equal(await holder.exited, 0);
});

// ---------------------------------------------------------------------------
// F05 - publishing a completion is all or nothing
// ---------------------------------------------------------------------------

test('F05 a failure while writing never leaves a half completion under the real name', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, result);

  const requestBefore = fileSha(join(prepared.exchangeDir, 'request.md'));
  const inputBefore = fileSha(join(prepared.exchangeDir, 'input.json'));
  const replyBefore = fileSha(join(prepared.exchangeDir, 'reply.md'));

  await assert.rejects(
    () => commitCompletion(prepared.exchangeDir, result, syntheticReceipt(), { faultPoints: ['completion-during-write'] }),
    (error) => error.code === 'store-fault-injected',
  );

  assert.equal(
    existsSync(join(prepared.exchangeDir, 'completion.json')),
    false,
    'the real file name never holds a partial document',
  );
  assert.equal(fileSha(join(prepared.exchangeDir, 'request.md')), requestBefore);
  assert.equal(fileSha(join(prepared.exchangeDir, 'input.json')), inputBefore);
  assert.equal(fileSha(join(prepared.exchangeDir, 'reply.md')), replyBefore);

  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.notEqual(recovered.stage, 'completed', 'an interrupted publication is not a completion');

  // Once the interruption is over the completion can still be published.
  const completion = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
  assert.equal(completion.status, 'reply-ready');
});

test('F05 a damaged completion left by an earlier version is reported, not thrown away', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, result);

  writeFileSync(join(prepared.exchangeDir, 'completion.json'), '{\n  "sche', 'utf8');

  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.equal(recovered.status, 'failed');
  assert.ok(
    recovered.problems.some((p) => p.includes('completion')),
    `the damaged file must be named, got: ${JSON.stringify(recovered.problems)}`,
  );
  assert.ok(recovered.evidence_refs.includes('completion.json'));
  assert.ok(existsSync(join(prepared.exchangeDir, 'completion.json')), 'recovery does not delete the evidence');
  assert.equal(fileSha(join(prepared.exchangeDir, 'reply.md')), sha256(Buffer.from(result.replyText, 'utf8')));
});

// ---------------------------------------------------------------------------
// F06 - opening an existing record for writing is still a write
// ---------------------------------------------------------------------------

test('F06 an existing record is re-checked before private content is added', async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'acp-mail-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const projectRoot = join(fixtureRoot, 'project');
  mkdirSync(projectRoot, { recursive: true });

  const created = await initProject(projectRoot, { gitProbe: () => ({ repository: false, tracked: false }) });
  assert.equal(created.created, true);

  let probeCalls = 0;
  const trackedProbe = () => {
    probeCalls += 1;
    return { repository: true, tracked: true };
  };

  await assert.rejects(
    () => initProject(projectRoot, { gitProbe: trackedProbe }),
    (error) => error.code === 'record-root-git-tracked',
    'an existing record is not a licence to keep writing',
  );
  assert.ok(probeCalls > 0, 'the check really ran on the second open');

  await assert.rejects(
    () => createTopic(created.record_root, { title: 'should not be written', related_topic_ids: [], gitProbe: trackedProbe }),
    (error) => error.code === 'record-root-git-tracked',
    'adding private content is a write and is checked as one',
  );

  // Reading what is already there stays possible.
  assert.equal(readProject(created.record_root).project_id, created.project_id);
});

// ===========================================================================
// T2-R2: the four root causes root reproduced against T2-R1.
//
// Written from the root counterexamples, not from what the implementation
// happens to do. Group names follow the review: F02-R2 to F06-R2.
// ===========================================================================

import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Publishes one clean completion and hands back everything needed to damage
// exactly one part of it afterwards.
async function completedExchange(t, resultOverrides = {}) {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult(resultOverrides);
  await saveReply(prepared.exchangeDir, result);
  const completion = await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
  return { f, dir: prepared.exchangeDir, result, completion };
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

// ---------------------------------------------------------------------------
// F02-R2 - a completion is only as good as the evidence still under it
// ---------------------------------------------------------------------------

test('F02-R2 a completion whose agent result is gone is no longer verified', async (t) => {
  const { dir, result } = await completedExchange(t);
  rmSync(join(dir, 'agent-result.json'), { force: true });

  const recovered = await recoverExchange(dir);
  assert.notEqual(recovered.status, 'reply-ready', 'the evidence behind the verdict is missing');
  assert.equal(recovered.stage, 'completion-unverified');
  assert.ok(
    recovered.problems.some((p) => p.includes('agent-result')),
    `the missing evidence must be named, got: ${JSON.stringify(recovered.problems)}`,
  );

  await assert.rejects(
    () => commitCompletion(dir, result, syntheticReceipt()),
    (error) => error.code === 'completion-unverified',
    'reading it again must reach the same verdict',
  );
});

test('F02-R2 a completion that disagrees with the saved stop reason is not verified', async (t) => {
  const { dir, result } = await completedExchange(t);
  const path = join(dir, 'agent-result.json');
  writeJson(path, { ...readJson(path), stop_reason: 'cancelled' });

  const recovered = await recoverExchange(dir);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.stage, 'completion-unverified');
  assert.ok(recovered.problems.length > 0, 'the disagreement must be reported');

  await assert.rejects(
    () => commitCompletion(dir, result, syntheticReceipt()),
    (error) => error.code === 'completion-unverified',
  );
});

test('F02-R2 an edited completion status is not accepted just because the word is legal', async (t) => {
  const { dir } = await completedExchange(t, { stopReason: 'cancelled' });
  const path = join(dir, 'completion.json');
  const published = readJson(path);
  assert.equal(published.status, 'cancelled', 'the fixture really did start as cancelled');
  writeJson(path, { ...published, status: 'reply-ready' });

  const recovered = await recoverExchange(dir);
  assert.notEqual(recovered.status, 'reply-ready');
  assert.equal(recovered.stage, 'completion-unverified');
  assert.ok(
    recovered.problems.some((p) => p.includes('status')),
    `the status must be named, got: ${JSON.stringify(recovered.problems)}`,
  );
});

test('F02-R2 an agent result of an unsupported schema is not accepted', async (t) => {
  const { dir } = await completedExchange(t);
  const path = join(dir, 'agent-result.json');
  writeJson(path, { ...readJson(path), schema_version: 999 });

  const recovered = await recoverExchange(dir);
  assert.notEqual(recovered.status, 'reply-ready');
  assert.ok(
    recovered.problems.some((p) => p.includes('schema')),
    `the schema must be named, got: ${JSON.stringify(recovered.problems)}`,
  );
});

test('F02-R2 the progress record must name the same letter as the input', async (t) => {
  const { dir } = await completedExchange(t);
  const path = join(dir, 'state.json');
  writeJson(path, { ...readJson(path), project_id: randomUUID() });

  const recovered = await recoverExchange(dir);
  assert.notEqual(recovered.status, 'reply-ready');
  assert.ok(
    recovered.problems.some((p) => p.includes('state.')),
    `the mismatch must be named, got: ${JSON.stringify(recovered.problems)}`,
  );
});

test('F02-R2 the completion records what was saved, not what the caller now claims', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);

  const saved = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, saved);

  const embellished = syntheticAcpResult({
    continuity: 'native-resume',
    nativeSessionRef: 'synthetic-session-that-was-never-observed',
    observed: { model: 'a-model-nobody-reported', thinking: 'high', source: 'provider-reported' },
  });

  await assert.rejects(
    () => commitCompletion(prepared.exchangeDir, embellished, syntheticReceipt()),
    (error) => error.code === 'agent-result-mismatch',
    'a caller may not decorate the record with things the endpoint never reported',
  );

  const completion = await commitCompletion(prepared.exchangeDir, saved, syntheticReceipt());
  assert.equal(completion.status, 'reply-ready');
  assert.equal(completion.continuity, 'new');
  assert.equal(completion.native_session_ref, null);
  assert.deepEqual(completion.observed, { model: null, thinking: null, source: 'unknown' });
});

test('F02-R2 a completion published just before the progress record was updated still verifies', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, result);

  const statePath = join(prepared.exchangeDir, 'state.json');
  const beforeCompletion = readJson(statePath);
  await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());

  // The completion reached the disk; the progress note did not. That is an
  // interruption, not damage, and the published record must still verify.
  writeJson(statePath, beforeCompletion);

  const recovered = await recoverExchange(prepared.exchangeDir);
  assert.equal(recovered.status, 'reply-ready');
  assert.equal(recovered.stage, 'completed');
  assert.deepEqual(recovered.problems, []);
});

test('F02-R2 a structurally invalid completion is diagnosed, not handed back as one', async (t) => {
  const { dir } = await completedExchange(t);
  const path = join(dir, 'completion.json');
  writeJson(path, { ...readJson(path), status: 'not-a-real-status' });

  const recovered = await recoverExchange(dir);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.completion, undefined, 'an invalid document is not returned as a Completion');
  assert.ok(recovered.evidence_refs.includes('completion.json'), 'it is still pointed at as evidence');
  assert.ok(recovered.problems.some((p) => p.includes('status')));
  assert.ok(existsSync(path), 'recovery never deletes a published reply');
});

test('F02-R2 an exchange still in progress is not forced into a permanent verdict', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);

  const archived = await recoverExchange(prepared.exchangeDir);
  assert.equal(archived.status, 'unconfirmed', 'an unsent normal draft is not a permanent failure');
  assert.deepEqual(archived.problems, [], 'a fresh draft has nothing wrong with it');
  assert.equal(archived.delivery, 'not-sent');

  await markDelivering(prepared.exchangeDir);
  const inFlight = await recoverExchange(prepared.exchangeDir);
  assert.equal(inFlight.status, 'unconfirmed');
  assert.deepEqual(inFlight.problems, [], 'a turn in flight is not damaged evidence');

  await savePartialReply(prepared.exchangeDir, 'half a reply');
  const partial = await recoverExchange(prepared.exchangeDir);
  assert.equal(partial.stage, 'partial-reply-only');
  assert.deepEqual(partial.problems, []);
});

// ---------------------------------------------------------------------------
// F04-R2 - recovering an old lock must never touch a new live one
// ---------------------------------------------------------------------------

test('F04-R2 a slow recovery does not delete the lock a new live owner took', async (t) => {
  const f = await createFixtureStore(t);
  const lockPath = join(f.root, 'index.lock');
  const readyFile = join(f.fixtureRoot, 'dead-index-ready');

  // A real process takes the index lock and dies holding it.
  const abandoner = startWorker(f, 'f04r2-abandon', { op: 'abandon-index-lock', recordRoot: f.root, readyFile });
  assert.equal(await abandoner.exited, 0);
  const deadNonce = JSON.parse(readFileSync(lockPath, 'utf8')).owner_nonce;

  // A second real process reclaims that dead lock and takes a live one of its
  // own, in the window between this recovery deciding and this recovery
  // deleting.
  const newOwnerReady = join(f.fixtureRoot, 'new-owner-ready');
  const newOwnerRelease = join(f.fixtureRoot, 'new-owner-release');
  let replacement = null;

  const originalSpawn = childProcess.spawnSync;
  let armed = false;
  childProcess.spawnSync = function (command, args, options) {
    const mutation = options?.input ? (() => { try { return JSON.parse(options.input); } catch { return null; } })() : null;
    if (!armed && mutation?.operation === 'delete' && mutation.path === lockPath) {
      armed = true;
      const taker = startWorker(f, 'f04r2-new-owner', {
        op: 'reclaim-and-hold-index-lock',
        recordRoot: f.root,
        readyFile: newOwnerReady,
        releaseFile: newOwnerRelease,
      });
      const deadline = Date.now() + 15000;
      while (!existsSync(newOwnerReady)) {
        if (Date.now() > deadline) throw new Error('new owner did not arrive at the barrier');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      replacement = JSON.parse(readFileSync(newOwnerReady, 'utf8'));
      // The successful path below releases this worker before the fixture's
      // cleanup hook. The outer process job bounds a failed test's children.
    }
    return originalSpawn(command, args, options);
  };
  syncBuiltinESMExports();
  let decisions;
  try { decisions = await store.recoverStoreLocks(f.root); }
  finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); }

  assert.ok(replacement, 'the competing process really did take the lock');
  assert.notEqual(replacement.owner_nonce, deadNonce, 'it is a different lock, not the dead one');

  const indexDecision = decisions.find((entry) => entry.kind === 'index');
  assert.ok(indexDecision, 'recovery still reports what it found');
  assert.equal(indexDecision.released, false, 'the old recovery must not delete the new owner lock');

  assert.ok(existsSync(lockPath), 'the live lock is still there');
  assert.equal(
    JSON.parse(readFileSync(lockPath, 'utf8')).owner_nonce,
    replacement.owner_nonce,
    'and it still belongs to the live owner',
  );

  writeFileSync(newOwnerRelease, 'release', 'utf8');
  await waitForFile(`${newOwnerReady}.finish`);
  const finish = JSON.parse(readFileSync(`${newOwnerReady}.finish`, 'utf8'));
  assert.equal(finish.released, true, 'the live owner released its own lock normally');
});

test('F04-R2 two processes reclaiming one dead lock: only one deletes it', async (t) => {
  const f = await createFixtureStore(t);
  const lockPath = join(f.root, 'index.lock');
  const readyFile = join(f.fixtureRoot, 'dead-for-two');

  const abandoner = startWorker(f, 'f04r2-abandon-two', { op: 'abandon-index-lock', recordRoot: f.root, readyFile });
  assert.equal(await abandoner.exited, 0);
  const deadNonce = JSON.parse(readFileSync(lockPath, 'utf8')).owner_nonce;

  const startAtMs = Date.now() + 500;
  const workers = ['f04r2-rec-a', 'f04r2-rec-b'].map((name) =>
    startWorker(f, name, { op: 'guarded-delete', lockPath, expectedNonce: deadNonce, startAtMs }),
  );
  await Promise.all(workers.map((w) => w.exited));
  const results = workers.map(workerResult);

  const deleted = results.filter((r) => r.result === 'deleted');
  assert.equal(deleted.length, 1, `exactly one delete may take effect, got ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => r.result === 'absent' || r.result === 'changed').length, 1);
  assert.equal(existsSync(lockPath), false);
});

test('F04-R2 the guarded section really holds other processes out', async (t) => {
  const f = await createFixtureStore(t);
  const lockPath = join(f.root, 'index.lock');
  const readyFile = join(f.fixtureRoot, 'dead-for-barrier');

  const abandoner = startWorker(f, 'f04r2-abandon-barrier', { op: 'abandon-index-lock', recordRoot: f.root, readyFile });
  assert.equal(await abandoner.exited, 0);
  const deadNonce = JSON.parse(readFileSync(lockPath, 'utf8')).owner_nonce;

  // One process sits inside the guarded section; the other must wait for it,
  // which is the only thing that makes read-check-delete safe.
  const holder = startWorker(f, 'f04r2-hold-guard', {
    op: 'guarded-delete',
    lockPath,
    expectedNonce: 'a-nonce-that-never-owned-this-lock',
    holdMs: 1500,
    readyFile: join(f.fixtureRoot, 'guard-entered'),
  });
  await waitForFile(join(f.fixtureRoot, 'guard-entered'));

  const began = Date.now();
  const waiter = startWorker(f, 'f04r2-wait-guard', { op: 'guarded-delete', lockPath, expectedNonce: deadNonce });
  await Promise.all([holder.exited, waiter.exited]);
  const waited = Date.now() - began;

  const holderResult = workerResult(holder);
  const waiterResult = workerResult(waiter);
  assert.equal(holderResult.result, 'changed', 'the holder saw a nonce that was not the one it expected');
  assert.equal(waiterResult.result, 'deleted', 'the waiter got in afterwards and did its work');
  assert.ok(waited >= 500, `the waiter must have been held back, it took ${waited} ms`);
});

test('F04-R2 a guard that is interrupted leaves the lock readable and the next attempt still decides', async (t) => {
  const f = await createFixtureStore(t);
  const lockPath = join(f.root, 'index.lock');
  const readyFile = join(f.fixtureRoot, 'dead-for-crash');

  const abandoner = startWorker(f, 'f04r2-abandon-crash', { op: 'abandon-index-lock', recordRoot: f.root, readyFile });
  assert.equal(await abandoner.exited, 0);
  const deadNonce = JSON.parse(readFileSync(lockPath, 'utf8')).owner_nonce;

  const guardReady = join(f.fixtureRoot, 'guard-to-kill');
  const killed = startWorker(f, 'f04r2-kill-guard', { op: 'guarded-delete', lockPath, expectedNonce: deadNonce, holdMs: 4000, readyFile: guardReady });
  await waitForFile(guardReady);
  // The marker is written by this fixture's actual mutex-owning process.
  process.kill(Number(readFileSync(guardReady, 'utf8')));
  await killed.exited;

  assert.ok(existsSync(lockPath), 'the interrupted guard did not take the lock file with it');
  const after = await store.recoverStoreLocks(f.root);
  const indexDecision = after.find((entry) => entry.kind === 'index');
  assert.ok(indexDecision, 'the next attempt still reaches a decision');
  assert.equal(indexDecision.released, true, 'and the dead owner lock is cleared');
  assert.equal(existsSync(lockPath), false);
});

// ---------------------------------------------------------------------------
// F05-R2 - no publication path may overwrite what is already published
// ---------------------------------------------------------------------------

test('F05-R2 a file system that cannot publish atomically fails instead of overwriting', async (t) => {
  const f = await createFixtureStore(t);
  const prepared = await prepareExchange(f.root, f.runId, f.exchangeId, f.bytes, f.input);
  await markDelivering(prepared.exchangeDir);
  const result = syntheticAcpResult();
  await saveReply(prepared.exchangeDir, result);

  const completionPath = join(prepared.exchangeDir, 'completion.json');
  const somebodyElse = Buffer.from('{"published":"by another writer"}\n', 'utf8');

  const originalLink = fs.linkSync;
  let linkAttempted = false;
  fs.linkSync = function refuseLinks() {
    linkAttempted = true;
    writeFileSync(completionPath, somebodyElse, { flag: 'wx' });
    const error = new Error('synthetic: hard links are not supported here');
    error.code = 'ENOTSUP';
    throw error;
  };
  syncBuiltinESMExports();

  let failure = null;
  try {
    await commitCompletion(prepared.exchangeDir, result, syntheticReceipt());
  } catch (error) {
    failure = error.code ?? String(error.message);
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }

  assert.equal(linkAttempted, true, 'the unsupported publication branch was actually reached');
  assert.equal(failure, 'atomic-publication-unsupported');
  assert.notEqual(failure, null);
  assert.deepEqual(readFileSync(completionPath), somebodyElse, 'the other writer content is untouched');
  assert.equal(fileSha(join(prepared.exchangeDir, 'reply.md')), sha256(Buffer.from(result.replyText, 'utf8')), 'the letter is kept');
});

test('F05-R2 an already published completion is never replaced', async (t) => {
  const { dir, result } = await completedExchange(t);
  const completionPath = join(dir, 'completion.json');
  const publishedBytes = readFileSync(completionPath);

  // A second publication of a different verdict must not get in.
  const other = syntheticAcpResult({ stopReason: 'cancelled' });
  let outcome;
  try {
    outcome = (await commitCompletion(dir, other, syntheticReceipt())).status;
  } catch (error) {
    outcome = error.code;
  }
  assert.notEqual(outcome, 'cancelled', 'the published verdict did not change');
  assert.deepEqual(readFileSync(completionPath), publishedBytes, 'the published bytes are untouched');

  const repeat = await commitCompletion(dir, result, syntheticReceipt());
  assert.equal(repeat.status, 'reply-ready', 'an honest repeat still reads back what was published');
});

// ---------------------------------------------------------------------------
// F06-R2 - every top-level write is checked again
// ---------------------------------------------------------------------------

test('F06-R2 a record that becomes tracked is refused on the next write, with no probe supplied', async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'acp-mail-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  // A Git repository above the project, so the store really does consult its
  // underlying observation rather than returning early.
  mkdirSync(join(fixtureRoot, '.git'), { recursive: true });
  const projectRoot = join(fixtureRoot, 'project');
  mkdirSync(projectRoot, { recursive: true });

  let tracked = false;
  let gitCalls = 0;
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    if (command === 'git') {
      gitCalls += 1;
      return { status: 0, stdout: tracked ? '.review-collaboration/project.json\n' : '', stderr: '', error: undefined };
    }
    return originalSpawnSync(command, args, options);
  };
  syncBuiltinESMExports();

  try {
    const project = await initProject(projectRoot);
    assert.equal(project.created, true, 'while it is untracked, the record is created normally');
    const firstTopic = await createTopic(project.record_root, { title: 'while untracked', related_topic_ids: [] });
    assert.ok(firstTopic.topic_id);

    // The same process, the same record root, no injected probe of any kind:
    // only the underlying observation changed.
    tracked = true;
    const callsBefore = gitCalls;

    await assert.rejects(
      () => createTopic(project.record_root, { title: 'after it became tracked', related_topic_ids: [] }),
      (error) => error.code === 'record-root-git-tracked',
      'a later write must be checked again, not waved through by an earlier success',
    );
    assert.ok(gitCalls > callsBefore, 'the check really ran again');

    await assert.rejects(
      () => openRun(project.record_root, {
        topic_id: firstTopic.topic_id,
        host_id: SYNTHETIC_SELECTION.host_id,
        host_session_key: 'synthetic-session-key',
        selection: SYNTHETIC_SELECTION,
        route: SYNTHETIC_ROUTE,
      }),
      (error) => error.code === 'record-root-git-tracked',
    );

    assert.equal(
      readdirSync(join(project.record_root, 'topics')).length,
      1,
      'no private content was added while the record was tracked',
    );

    // Reading what is already archived stays possible.
    assert.equal(readProject(project.record_root).project_id, project.project_id);
    assert.ok((readIndex(project.record_root) ?? []).some((e) => e.topic_id === firstTopic.topic_id));
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
});

test('F06-R2 one write operation does not run the check over and over', async (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'acp-mail-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  mkdirSync(join(fixtureRoot, '.git'), { recursive: true });
  const projectRoot = join(fixtureRoot, 'project');
  mkdirSync(projectRoot, { recursive: true });

  let gitCalls = 0;
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    if (command === 'git') {
      gitCalls += 1;
      return { status: 0, stdout: '', stderr: '', error: undefined };
    }
    return originalSpawnSync(command, args, options);
  };
  syncBuiltinESMExports();

  try {
    const project = await initProject(projectRoot);
    const before = gitCalls;
    await createTopic(project.record_root, { title: 'one operation', related_topic_ids: [] });
    const spent = gitCalls - before;
    assert.ok(spent >= 1, 'the operation is checked');
    assert.ok(spent <= 2, `one write operation must not re-run the check for every step, it ran ${spent} times`);
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
});
