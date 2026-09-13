// Offline test runner.
//
// Test files are listed explicitly and launched with an argument array, so no
// shell wildcard decides what ran. Suites that belong to later tasks are
// reported as not-implemented rather than skipped: "skipped" would let an
// unwritten suite look like a passing one.
//
// Every test file runs under the same Windows Job transport the product uses,
// so a test that hangs is stopped by a deadline and its whole process tree is
// terminated with it. A run that ends for any reason still writes results.json;
// a run that cannot produce a trustworthy verdict exits nonzero.
//
// The evidence directory must not already exist: earlier results are evidence
// and are never overwritten.
//
// Usage: node tests/run-offline.mjs --evidence-root <new dir>
//        [--per-test-timeout-ms <n>] [--extra-test <file>]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testsRoot, '..');
const invokeProcess = join(packageRoot, 'scripts', 'invoke-process.ps1');

const IMPLEMENTED_TESTS = [
  {id:'acp-auth',file:'acp-auth.test.mjs',covers:['ACP-authentication','first-connection'],scope:'Handwritten two-identity endpoints, explicit auth selection, no prompt during login, route fingerprint and bounded public wrapper; no real credentials.'},
  {id:'argv-launcher',file:'argv-launcher.test.mjs',covers:['argv-native','stdin-bytes','child-exit'],scope:'Compiled native argv launcher, synthetic child only; runtime lives in package private cache.'},
  {id:'export',file:'export.test.mjs',covers:['X01','X02','X03'],scope:'Exact public set, document links, before/after source hashes and an injected deterministic source-change barrier. Moved execution/live verification is reported separately.'},
  {id:'profile-route',file:'profile-route.test.mjs',covers:['P01-P06','D01-D06','S05'],scope:'Synthetic routes, local identity/settings and injected registry data; no installed reviewer certification.'},
  {id:'safe-files',file:'safe-files.test.mjs',covers:['S02','S06','S07'],scope:'Actual local junction and isolated Git tests; ordinary path admission, not hostile OS sandbox.'},
  {id:'acp-lifecycle',file:'acp-lifecycle.test.mjs',covers:['A03-A10','S03'],scope:'Handwritten synthetic JSON-RPC endpoint; actual process exchange and bounded cancellation.'},
  {id:'mail-exchange',file:'mail-exchange.test.mjs',covers:['M03-wrapper-finalize','C01','C02','C05','E01-E07','W01','W02','S01'],scope:'Actual wrapper and synthetic ACP endpoint. E04 explicitly injects process receipt fields; no real unclean OS process state is claimed.'},
  {
    id: 'acp-client',
    file: 'acp-client.test.mjs',
    covers: ['A01', 'A02', 'initialize-only', 'cancel-minimal', 'not-implemented-guards'],
    scope: 'a synthetic endpoint only; no reviewer, adapter or model is involved',
  },
  {
    id: 'runner-guard',
    file: 'runner-guard.test.mjs',
    covers: ['runner-outcome-rejection'],
    scope: 'how this runner reads a transport receipt; not the transport itself',
  },
  {
    id: 'mail-store',
    file: 'mail-store.test.mjs',
    covers: ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'C01', 'C02', 'C03', 'C04'],
    scope:
      'the record layer only: archiving, hashes, locks, completion and recovery, with a synthetic AcpResult and a synthetic ProcessReceipt. '
      + 'The concurrency cases run real separate processes. What is counted at the sending step is a store admission, not a model prompt: '
      + 'no ACP delivery, no real wrapper finalize and no reviewer is exercised here.',
  },
];

const NOT_IMPLEMENTED = [
  { id: 'host-workflow', covers: ['H01-H09'], due: 'T6/T8' },
  { id: 'real-routes', covers: ['L01-L12','S04'], due: 'T8' },
];

const DEFAULT_PER_TEST_TIMEOUT_MS = 480000;

// What a trustworthy receipt has to say. Every entry must be present with
// exactly this value: an absent field is a rejection, never a default that
// happens to look like success.
const REQUIRED_RECEIPT_VALUES = [
  ['schema_version', 1],
  ['transport_status', 'success'],
  ['transport_exit_code', 0],
  ['native_exit_code', 0],
  ['process_started', true],
  ['timed_out', false],
  ['stdout_truncated', false],
  ['stderr_truncated', false],
];

// cleanup_complete is derived inside the transport from process_exited, the
// three stream completions, job_attached and owned_processes_remaining, so
// these are checked as the components of that claim rather than taken on trust.
const REQUIRED_CLEANUP_VALUES = [
  ['job_created', true],
  ['job_attached', true],
  ['process_exited', true],
  ['stdin_completed', true],
  ['stdout_completed', true],
  ['stderr_completed', true],
  ['stream_wait_timed_out', false],
  ['cleanup_complete', true],
  ['owned_processes_remaining', 0],
];

// Present on both the normal and the timeout path, so its value carries no
// pass or fail information; only its presence is part of the receipt shape.
const REQUIRED_CLEANUP_PRESENT = ['tree_terminated'];

// A capture error means the recorded output is incomplete, which makes the
// test's own verdict unusable no matter what the exit code says.
const REQUIRED_CAPTURE_NULL = ['launch_error', 'stdin_error', 'stdout_error', 'stderr_error'];

function has(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function checkValues(object, required, prefix, problems) {
  for (const [field, expected] of required) {
    if (!has(object, field)) problems.push(`${prefix}missing-${field}`);
    else if (object[field] !== expected) problems.push(`${prefix}${field}=${JSON.stringify(object[field])}`);
  }
}

/**
 * Decides whether one transported test run may be called a pass.
 *
 * A missing, unreadable or incomplete receipt is a failure: without one there
 * is no evidence that the test finished, and silence is not a pass.
 */
export function evaluateTransportOutcome(outputDir) {
  const receiptPath = join(outputDir, 'receipt.json');
  if (!existsSync(receiptPath)) return { status: 'fail', reason: 'transport-receipt-missing', receipt: null };

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return { status: 'fail', reason: 'transport-receipt-unreadable', receipt: null };
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { status: 'fail', reason: 'transport-receipt-unreadable', receipt: null };
  }

  const problems = [];
  checkValues(receipt, REQUIRED_RECEIPT_VALUES, '', problems);

  const cleanup = receipt.cleanup;
  if (!has(receipt, 'cleanup') || cleanup === null || typeof cleanup !== 'object') {
    problems.push('cleanup-absent');
  } else {
    checkValues(cleanup, REQUIRED_CLEANUP_VALUES, 'cleanup.', problems);
    for (const field of REQUIRED_CLEANUP_PRESENT) {
      if (!has(cleanup, field)) problems.push(`cleanup.missing-${field}`);
    }
  }

  const capture = receipt.capture;
  if (!has(receipt, 'capture') || capture === null || typeof capture !== 'object') {
    problems.push('capture-absent');
  } else {
    checkValues(capture, REQUIRED_CAPTURE_NULL.map((field) => [field, null]), 'capture.', problems);
  }

  return problems.length === 0
    ? { status: 'pass', reason: null, receipt }
    : { status: 'fail', reason: problems.join('; '), receipt };
}

/**
 * Decides whether the process that carried out one case is itself trustworthy.
 *
 * Separate from the receipt on purpose: the wrapper's own exit code and the
 * test process's exit code answer different questions and are reported apart.
 */
export function evaluateWrapperRun(run) {
  if (run?.error) return `wrapper-${run.error.code ?? 'spawn-failed'}`;
  if (run?.status !== 0) return `wrapper-exit-${run?.status === null || run?.status === undefined ? 'unknown' : run.status}`;
  return null;
}

export function evaluateTestSummary(log) {
  const counts={};
  for(const label of ['tests','pass','fail','cancelled','skipped','todo']){
    const matches=[...String(log).matchAll(new RegExp('^(?:ℹ|#)\\s+'+label+'\\s+(\\d+)\\s*$','gm'))];
    counts[label]=matches.length?Number(matches.at(-1)[1]):null;
  }
  const valid=Number.isSafeInteger(counts.tests)&&counts.tests>0&&counts.pass===counts.tests
    &&counts.fail===0&&counts.cancelled===0&&counts.skipped===0&&counts.todo===0;
  return {counts,reason:valid?null:'test-summary-missing-empty-or-incomplete'};
}

function argValues(args, name) {
  const found = [];
  for (let i = 0; i < args.length - 1; i += 1) if (args[i] === name) found.push(args[i + 1]);
  return found;
}

function runOneTest(entry, evidenceRoot, timeoutMs) {
  // Node expands --test path globs even for explicitly supplied files. Keep
  // directory characters out of the pattern; public test basenames are fixed.
  const testName=basename(entry.path);
  if(!existsSync(entry.path)||/[\[\]{}*?!]/.test(testName))throw new Error('test-file-missing-or-pattern-name');
  const caseDir = join(evidenceRoot, entry.id);
  const outputDir = join(caseDir, 'transport-output');
  mkdirSync(caseDir, { recursive: true });

  const stdinFile = join(caseDir, 'stdin.bin');
  writeFileSync(stdinFile, '', 'utf8');

  const transportRequest = join(caseDir, 'transport-request.json');
  writeFileSync(
    transportRequest,
    JSON.stringify(
      {
        version: 1,
        executable: process.execPath,
        arguments: ['--test', testName],
        working_directory: dirname(entry.path),
        stdin_file: stdinFile,
        timeout_ms: timeoutMs,
      },
      null,
      2,
    ),
    'utf8',
  );

  const argv = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    invokeProcess,
    '-RequestFile',
    transportRequest,
    '-OutputDirectory',
    outputDir,
  ];

  const began = Date.now();
  // The transport enforces the deadline and owns the process tree; this outer
  // limit only covers a wrapper that never returns at all.
  const run = spawnSync('powershell.exe', argv, {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: timeoutMs + 30000,
    env: {...process.env, REVIEW_MAIL_TEST_EVIDENCE:join(caseDir,'cases')},
  });
  const durationMs = Date.now() - began;

  writeFileSync(join(caseDir, 'wrapper.log'), `${run.stdout ?? ''}\n--- stderr ---\n${run.stderr ?? ''}`, 'utf8');

  const outcome = evaluateTransportOutcome(outputDir);
  // Both have to be satisfied: the wrapper process must have finished cleanly,
  // and the receipt it left must be complete and consistent.
  const wrapperFailure = evaluateWrapperRun(run);
  const stdoutFile=join(outputDir,'stdout.bin');
  const summary=evaluateTestSummary(existsSync(stdoutFile)?readFileSync(stdoutFile,'utf8'):'');
  const problems = [wrapperFailure, outcome.reason, summary.reason].filter(Boolean);
  const status = problems.length === 0 && outcome.status === 'pass' ? 'pass' : 'fail';
  const reason = problems.length === 0 ? null : problems.join('; ');

  return {
    id: entry.id,
    status,
    covers: entry.covers,
    scope: entry.scope ?? null,
    command: ['powershell.exe', ...argv].join(' '),
    cwd: packageRoot,
    test_file: entry.path,
    test_cwd: dirname(entry.path),
    test_counts: summary.counts,
    deadline_ms: timeoutMs,
    native_exit: outcome.receipt ? outcome.receipt.native_exit_code : null,
    wrapper_exit: run.status,
    timed_out: outcome.receipt ? outcome.receipt.timed_out === true : null,
    owned_processes_remaining: outcome.receipt?.cleanup?.owned_processes_remaining ?? null,
    duration_ms: durationMs,
    evidence_refs: [join(entry.id, 'wrapper.log'), join(entry.id, 'transport-output', 'receipt.json')],
    reason,
  };
}

function main() {
  const args = process.argv.slice(2);
  const evidenceArgument = argValues(args, '--evidence-root')[0];
  if (!evidenceArgument) {
    process.stderr.write('--evidence-root <dir> is required\n');
    process.exit(64);
  }
  // Child cwd is the package; resolve caller-relative paths before changing it.
  const evidenceRoot = resolve(evidenceArgument);
  if (existsSync(evidenceRoot)) {
    process.stderr.write(`evidence root already exists, refusing to overwrite earlier results: ${evidenceRoot}\n`);
    process.exit(65);
  }

  const timeoutRaw = argValues(args, '--per-test-timeout-ms')[0];
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_PER_TEST_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    process.stderr.write('--per-test-timeout-ms must be an integer of at least 1000\n');
    process.exit(64);
  }

  // Extra test files exist so the runner's own deadline and failure handling
  // can be exercised by a controlled counterexample.
  const extra = argValues(args, '--extra-test').map((file) => ({
    id: `extra-${basename(file).replace(/[^A-Za-z0-9._-]/g, '_')}`,
    path: resolve(file),
    covers: ['runner-deadline'],
  }));

  mkdirSync(evidenceRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const cases = [];
  let runnerError = null;

  try {
    for (const entry of [...IMPLEMENTED_TESTS.map((e) => ({ ...e, path: join(testsRoot, e.file) })), ...extra]) {
      cases.push(runOneTest(entry, evidenceRoot, timeoutMs));
    }
  } catch (error) {
    runnerError = String(error?.stack ?? error);
    cases.push({id:'runner-infrastructure',status:'fail',reason:runnerError});
  }

  for (const entry of NOT_IMPLEMENTED) {
    cases.push({
      id: entry.id,
      status: 'not-run',
      covers: entry.covers,
      note: entry.note ?? null,
      command: null,
      cwd: null,
      native_exit: null,
      duration_ms: null,
      evidence_refs: [],
      reason: `not implemented yet; due in ${entry.due}`,
    });
  }

  const failed = cases.filter((c) => c.status === 'fail');
  const results = {
    schema_version: 1,
    task_id: 'ACP-MAIL-20260911',
    task: 'ACP-mail',
    suite: 'offline',
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    node_version: process.version,
    per_test_timeout_ms: timeoutMs,
    passed: cases.filter((c) => c.status === 'pass').length,
    failed: failed.length,
    not_run: cases.filter((c) => c.status === 'not-run').length,
    runner_error: runnerError,
    claim_scope: 'only the listed implemented suites were executed; not-run entries are not counted as passing',
    cases,
  };
  const resultsPath = join(evidenceRoot, 'results.json');
  writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf8');

  process.stdout.write(
    `results=${resultsPath}\npassed=${results.passed} failed=${results.failed} not_run=${results.not_run}\n`,
  );
  process.exit(failed.length === 0 && runnerError === null ? 0 : 1);
}

// Imported by the guard test for evaluateTransportOutcome; only a direct launch
// runs the suite.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
