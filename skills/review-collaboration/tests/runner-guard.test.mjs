// The runner decides pass or fail from a transport receipt and from the exit
// of the process that produced it. These cases cover what must never be read
// as a pass.
//
// The positive fixture is a complete receipt in the shape the transport really
// writes. Each negative case changes exactly one thing about it, so a case that
// fails names the one field responsible. Dropping a field is a case of its own:
// an absent field must be rejected, not treated as a convenient default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateTransportOutcome, evaluateWrapperRun, evaluateTestSummary } from './run-offline.mjs';

const summary=(n=2,passed=2,skipped=0)=>`ℹ tests ${n}\nℹ pass ${passed}\nℹ fail 0\nℹ cancelled 0\nℹ skipped ${skipped}\nℹ todo 0\n`;
test('runner requires a real nonempty fully passing test summary',()=>assert.equal(evaluateTestSummary(summary()).reason,null));
test('runner rejects Node zero-match glob success',()=>assert.ok(evaluateTestSummary(summary(0,0)).reason));
test('runner rejects a clean process with no test summary',()=>assert.ok(evaluateTestSummary('ordinary output').reason));
test('runner rejects skipped tests as full validation',()=>assert.ok(evaluateTestSummary(summary(2,1,1)).reason));
test('runner parses TAP totals as well as spec totals',()=>assert.equal(evaluateTestSummary(summary().replaceAll('ℹ','#')).reason,null));

// Copied in shape from a receipt written by a real synthetic test run.
const CLEAN_RECEIPT = {
  schema_version: 1,
  transport: 'shared-windows-native-exe',
  transport_status: 'success',
  transport_exit_code: 0,
  transport_only: true,
  semantic_review_validated: false,
  request_file: 'C:\\synthetic\\transport-request.json',
  resolved_executable: 'C:\\synthetic\\node.exe',
  resolved_arguments: ['--test', 'C:\\synthetic\\some.test.mjs'],
  resolved_working_directory: 'C:\\synthetic',
  input_file: 'C:\\synthetic\\stdin.bin',
  input_bytes: 0,
  input_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  timeout_ms: 120000,
  stream_cap_bytes: 16777216,
  process_started: true,
  native_exit_code: 0,
  timed_out: false,
  stdout_truncated: false,
  stderr_truncated: false,
  cleanup: {
    job_created: true,
    job_attached: true,
    tree_terminated: true,
    process_exited: true,
    owned_processes_remaining: 0,
    stdin_completed: true,
    stdout_completed: true,
    stderr_completed: true,
    stream_wait_timed_out: false,
    cleanup_complete: true,
  },
  capture: { stdout_bytes: 538, stderr_bytes: 0, stdout_error: null, stderr_error: null, stdin_error: null, launch_error: null },
  artifacts: { stdout: 'stdout.bin', stderr: 'stderr.bin', receipt: 'receipt.json' },
};

function withOutputDir(body) {
  const root = mkdtempSync(join(tmpdir(), 'acp-guard-'));
  const outputDir = join(root, 'transport-output');
  mkdirSync(outputDir);
  try {
    return body(outputDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function evaluateReceipt(receipt) {
  return withOutputDir((outputDir) => {
    writeFileSync(join(outputDir, 'receipt.json'), JSON.stringify(receipt), 'utf8');
    return evaluateTransportOutcome(outputDir);
  });
}

function altered(change) {
  const receipt = structuredClone(CLEAN_RECEIPT);
  change(receipt);
  return receipt;
}

test('a missing receipt is a failure, not a silent pass', () => {
  withOutputDir((outputDir) => {
    const outcome = evaluateTransportOutcome(outputDir);
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.reason, 'transport-receipt-missing');
  });
});

test('a receipt that is not readable JSON is a failure', () => {
  withOutputDir((outputDir) => {
    writeFileSync(join(outputDir, 'receipt.json'), '{ this is not json', 'utf8');
    const outcome = evaluateTransportOutcome(outputDir);
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.reason, 'transport-receipt-unreadable');
  });
});

test('a complete and consistent receipt is the only shape that passes', () => {
  const outcome = evaluateReceipt(CLEAN_RECEIPT);
  assert.equal(outcome.status, 'pass', `the clean fixture must pass, got: ${outcome.reason}`);
  assert.equal(outcome.reason, null);
});

// One changed field per case; the expected fragment names the field that must
// appear in the rejection reason.
const REJECTED = [
  ['a capture error was recorded', (r) => { r.capture.stdout_error = 'synthetic-capture-failure'; }, 'capture.stdout_error'],
  ['the capture block is absent', (r) => { delete r.capture; }, 'capture-absent'],
  ['the transport itself exited nonzero', (r) => { r.transport_exit_code = 10; }, 'transport_exit_code=10'],
  ['stdout was truncated', (r) => { r.stdout_truncated = true; }, 'stdout_truncated=true'],
  ['the timeout field is absent', (r) => { delete r.timed_out; }, 'missing-timed_out'],
  ['a deadline was hit', (r) => { r.timed_out = true; }, 'timed_out=true'],
  ['stderr was truncated', (r) => { r.stderr_truncated = true; }, 'stderr_truncated=true'],
  ['the transport never ran', (r) => { r.transport_status = 'preflight-failure'; }, 'transport_status="preflight-failure"'],
  ['the test process exited nonzero', (r) => { r.native_exit_code = 1; }, 'native_exit_code=1'],
  ['the process never started', (r) => { r.process_started = false; }, 'process_started=false'],
  ['the receipt schema is not the one understood here', (r) => { r.schema_version = 2; }, 'schema_version=2'],
  ['the cleanup block is absent', (r) => { delete r.cleanup; }, 'cleanup-absent'],
  ['the tree was not cleaned up', (r) => { r.cleanup.cleanup_complete = false; }, 'cleanup.cleanup_complete=false'],
  ['a process of this run survived', (r) => { r.cleanup.owned_processes_remaining = 2; }, 'cleanup.owned_processes_remaining=2'],
  ['the stream wait ran out of time', (r) => { r.cleanup.stream_wait_timed_out = true; }, 'cleanup.stream_wait_timed_out=true'],
  ['stdout was never fully read', (r) => { r.cleanup.stdout_completed = false; }, 'cleanup.stdout_completed=false'],
  ['the process did not exit', (r) => { r.cleanup.process_exited = false; }, 'cleanup.process_exited=false'],
  ['no job owned the process', (r) => { r.cleanup.job_attached = false; }, 'cleanup.job_attached=false'],
  ['the cleanup verdict is absent', (r) => { delete r.cleanup.cleanup_complete; }, 'cleanup.missing-cleanup_complete'],
  ['the survivor count is absent', (r) => { delete r.cleanup.owned_processes_remaining; }, 'cleanup.missing-owned_processes_remaining'],
  ['the termination record is absent', (r) => { delete r.cleanup.tree_terminated; }, 'cleanup.missing-tree_terminated'],
  ['a capture error field is absent', (r) => { delete r.capture.launch_error; }, 'capture.missing-launch_error'],
];

for (const [label, change, expected] of REJECTED) {
  test(`a receipt saying ${label} is rejected`, () => {
    const outcome = evaluateReceipt(altered(change));
    assert.equal(outcome.status, 'fail');
    assert.ok(outcome.reason.includes(expected), `reason must name the problem "${expected}", got: ${outcome.reason}`);
  });
}

test('the wrapper process is judged separately from the receipt', () => {
  assert.equal(evaluateWrapperRun({ status: 0, error: undefined }), null);
  assert.equal(evaluateWrapperRun({ status: 1, error: undefined }), 'wrapper-exit-1');
  assert.equal(evaluateWrapperRun({ status: null, error: undefined }), 'wrapper-exit-unknown');
  assert.equal(evaluateWrapperRun({ status: 0, error: { code: 'ETIMEDOUT' } }), 'wrapper-ETIMEDOUT');
});
