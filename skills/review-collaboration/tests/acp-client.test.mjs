import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAcpInitialize, runAcpTurn } from '../scripts/lib/acp-client.mjs';
import { SCENARIO_BODIES } from './fixtures/acp-fixture.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/acp-fixture.mjs', import.meta.url));

function newWorkDir() {
  return mkdtempSync(join(tmpdir(), 'acp-t1-'));
}

function routeFor(workDir, scenario, identity) {
  const eventLog = join(workDir, `events-${identity}.jsonl`);
  return {
    route: {
      route_id: `test-${identity}`,
      reviewer_tool_id: identity,
      kind: 'acp',
      launch: {
        executable: process.execPath,
        arguments: [FIXTURE, '--scenario', scenario, '--identity', identity, '--event-log', eventLog],
      },
    },
    eventLog,
  };
}

function readEvents(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const NO_SELECTION = {
  model: { source: 'provider-default', value: null },
  thinking: { source: 'provider-default', value: null },
};

function textBlocks(text) {
  return [{ type: 'text', text }];
}

// Synthetic request text with the properties that break naive transports:
// multi-byte characters, an emoji, blank lines, significant leading and
// trailing spaces, and text that looks like shell syntax but is only data.
const REQUEST_BODY = [
  '請審這封信：第一段是繁體中文。',
  '',
  'Second paragraph mixes ASCII with 中文, an emoji 🐉 and 🪁 at the end.',
  '   縮排與行尾空白都要保留   ',
  'shell-looking but inert: $(whoami) `backtick` \\ "quoted" & | > < 「引號」',
].join('\n');

// The endpoint records the blocks it actually received. Comparing the caller's
// input against that record is what makes a substituted prompt visible.
function assertSubmitted(events, expectedBlocks, label) {
  const prompts = events.filter((e) => e.event === 'prompt');
  assert.equal(prompts.length, 1, `${label}: exactly one prompt must reach the endpoint`);

  const expectedText = expectedBlocks.map((b) => b.text).join('');
  assert.deepEqual(prompts[0].received_blocks, expectedBlocks, `${label}: blocks must arrive unchanged`);
  assert.equal(prompts[0].received_text, expectedText, `${label}: submitted text must be the caller's text`);
  assert.equal(
    prompts[0].received_sha256,
    createHash('sha256').update(expectedText, 'utf8').digest('hex'),
    `${label}: submitted bytes must hash to the caller's text`,
  );
  assert.equal(prompts[0].received_bytes, Buffer.byteLength(expectedText, 'utf8'), `${label}: byte length must match`);
  return prompts[0];
}

test('A01: the same client drives two unrelated identities, one prompt each', async () => {
  const workDir = newWorkDir();
  try {
    const results = [];
    const submitted = [];
    const blocks = textBlocks(REQUEST_BODY);
    for (const identity of ['fixture-orchid', 'fixture-cedar']) {
      const { route, eventLog } = routeFor(workDir, 'echo', identity);
      const result = await runAcpTurn(route, NO_SELECTION, blocks, { workDir });
      const events = readEvents(eventLog);

      submitted.push(assertSubmitted(events, blocks, identity));
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result.replyText, SCENARIO_BODIES.echo, `${identity} reply must match the fixture body`);
      assert.ok(result.nativeSessionRef, 'a session reference must be observed');

      const methods = events.filter((e) => e.event === 'request').map((e) => e.method);
      assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt']);
      results.push(result);
    }

    // Core must not branch on identity: both runs take the same path, and the
    // text on the wire must be the same for both endpoints.
    assert.equal(results[0].replyText, results[1].replyText);
    assert.equal(submitted[0].received_text, submitted[1].received_text, 'identity must not change what is sent');
    assert.equal(submitted[0].received_sha256, submitted[1].received_sha256);
    assert.notEqual(results[0].nativeSessionRef, results[1].nativeSessionRef);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('A02: UTF-8 split across byte chunks survives byte-for-byte', async () => {
  const workDir = newWorkDir();
  try {
    const { route, eventLog } = routeFor(workDir, 'utf8-split', 'fixture-orchid');
    const blocks = textBlocks(REQUEST_BODY);
    const result = await runAcpTurn(route, NO_SELECTION, blocks, { workDir });

    // Outbound first: the endpoint must have received exactly the caller's
    // bytes. A reply that looks right proves nothing about what was sent.
    assertSubmitted(readEvents(eventLog), blocks, 'A02');

    const expected = SCENARIO_BODIES['utf8-split'];
    assert.equal(result.replyText, expected, 'reply text must be identical');
    assert.equal(
      Buffer.from(result.replyText, 'utf8').toString('hex'),
      Buffer.from(expected, 'utf8').toString('hex'),
      'reply bytes must be identical',
    );

    // The fixture records what it actually sent; compare against that too, so
    // the assertion does not rest on the imported constant alone.
    const sent = readEvents(eventLog).find((e) => e.event === 'body-sent');
    assert.ok(sent, 'fixture must record the body it sent');
    assert.equal(createHash('sha256').update(result.replyText, 'utf8').digest('hex'), sent.sha256);

    assert.ok(result.replyText.includes('🐉'), 'emoji must survive');
    assert.ok(result.replyText.includes('\n\n'), 'blank lines must survive');
    assert.ok(result.replyText.includes('$()'), 'shell-looking text must be preserved as data');
    assert.ok(!result.replyText.includes('['), 'no ANSI escapes may be mixed in');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('initialize only: the handshake runs and nothing is asked of the endpoint', async () => {
  const workDir = newWorkDir();
  try {
    const { route, eventLog } = routeFor(workDir, 'echo', 'fixture-orchid');
    const result = await runAcpInitialize(route, { workDir });

    const events = readEvents(eventLog);
    const methods = events.filter((e) => e.event === 'request').map((e) => e.method);
    assert.deepEqual(methods, ['initialize'], 'initialize-only must issue the handshake and nothing else');
    assert.equal(events.filter((e) => e.event === 'prompt').length, 0, 'no prompt may be submitted');

    assert.equal(result.promptsSubmitted, 0, 'the result must report that nothing was asked');
    assert.equal(result.initialized, true);
    assert.equal(typeof result.protocolVersion, 'number');
    assert.equal(result.reviewerProcess.closeReason, 'graceful');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('cancel: a cancelled turn keeps late content and reports cancelled', async () => {
  const workDir = newWorkDir();
  try {
    const { route, eventLog } = routeFor(workDir, 'late-after-cancel', 'fixture-cedar');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const result = await runAcpTurn(route, NO_SELECTION, textBlocks('請開始後取消'), {
      workDir,
      signal: controller.signal,
    });

    assert.equal(result.stopReason, 'cancelled', 'stop reason must be preserved as sent');
    assert.equal(result.cancelRequested, true);
    assert.ok(result.replyText.includes(SCENARIO_BODIES['late-after-cancel']), 'content before cancel is kept');
    assert.ok(result.replyText.includes('late chunk after cancel.'), 'late content is kept, not discarded');

    const events = readEvents(eventLog);
    assert.equal(events.filter((e) => e.event === 'cancel').length, 1);
    assert.equal(events.filter((e) => e.event === 'prompt').length, 1, 'cancel must not cause a second prompt');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('unsupported capabilities fail loudly instead of silently substituting sessions or settings', async () => {
  const workDir = newWorkDir();
  try {
    const { route } = routeFor(workDir, 'echo', 'fixture-orchid');

    const resume = await runAcpTurn(route, NO_SELECTION, textBlocks('x'), { workDir, resumeRef: 'some-session' });
    assert.equal(resume.errorCode, 'session-reconstruction-required');
    assert.equal(resume.promptsSubmitted, 0);

    const setting = await runAcpTurn(route, { model: { source: 'user', value: 'some-model' }, thinking: NO_SELECTION.thinking }, textBlocks('x'), {
          workDir,
        });
    assert.equal(setting.errorCode, 'configuration-mapping-required');
    assert.equal(setting.promptsSubmitted, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
