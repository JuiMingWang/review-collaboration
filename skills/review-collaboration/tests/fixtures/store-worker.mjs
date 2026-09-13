// A small separate process that drives the mail store.
//
// The concurrency cases are about what happens between operating system
// processes: two callbacks taking turns inside one Node process would prove
// nothing about an exclusive file lock. Each worker is launched with a JSON job
// file and writes its outcome next to it, so the test can read what really
// happened even when the worker was meant to die mid-job.
//
// Usage: node tests/fixtures/store-worker.mjs <jobFile>

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// Namespace import so a job that needs an export which does not exist yet fails
// on its own line instead of stopping the whole fixture from loading.
import * as store from '../../scripts/lib/mail-store.mjs';

const {
  acquireStoreLock,
  bumpTopicRevision,
  commitCompletion,
  createTopic,
  markDelivering,
  prepareExchange,
  saveReply,
  savePartialReply,
  withRunLock,
} = store;

const jobFile = process.argv[2];
const job = JSON.parse(readFileSync(jobFile, 'utf8'));
const resultFile = `${jobFile}.result.json`;

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitUntil(epochMs) {
  const remaining = epochMs - Date.now();
  if (remaining > 0) sleep(remaining);
}

function report(value) {
  writeFileSync(resultFile, JSON.stringify({ pid: process.pid, ...value }, null, 2), 'utf8');
}

// Stands in for handing the letter to a reviewer. There is no ACP connection in
// this task, so what is counted is how many times the store let a caller reach
// the sending step for one run.
function recordPromptAdmission(job) {
  if (job.promptLogFile) appendFileSync(job.promptLogFile, `${job.exchangeId ?? job.op} ${process.pid}\n`, 'utf8');
}

async function main() {
  if (job.startAtMs) waitUntil(job.startAtMs);

  switch (job.op) {
    case 'hold-lock': {
      await withRunLock(job.recordRoot, job.runId, async () => {
        writeFileSync(job.readyFile, String(process.pid), 'utf8');
        if(job.releaseFile){
          const deadline=Date.now()+30000;
          while(!existsSync(job.releaseFile)){if(Date.now()>deadline)throw Error('holder-release-timeout');sleep(10);}
        } else sleep(job.holdMs ?? 0);
      });
      report({ op: job.op, acquired: true, released: true });
      return;
    }

    case 'abandon-lock': {
      // Takes the lock and dies without releasing it, the way a killed process
      // would. process.exit skips the release, which is the point.
      await withRunLock(job.recordRoot, job.runId, async () => {
        writeFileSync(job.readyFile, String(process.pid), 'utf8');
        report({ op: job.op, acquired: true, released: false, abandoned: true });
        process.exit(0);
      });
      return;
    }

    case 'try-lock': {
      try {
        await withRunLock(job.recordRoot, job.runId, async () => {
          recordPromptAdmission(job);
          sleep(job.holdMs ?? 0);
        });
        report({ op: job.op, acquired: true, code: null });
      } catch (error) {
        report({ op: job.op, acquired: false, code: error.code ?? null, message: String(error.message) });
      }
      return;
    }

    case 'create-topic': {
      const topic = await createTopic(job.recordRoot, { title: job.title, related_topic_ids: [] });
      report({ op: job.op, topic_id: topic.topic_id, revision: topic.revision });
      return;
    }

    case 'exchange-turn': {
      const bytes = Buffer.from(job.requestText, 'utf8');
      try {
        const outcome = await withRunLock(job.recordRoot, job.runId, async () => {
          const prepared = await prepareExchange(job.recordRoot, job.runId, job.exchangeId, bytes, job.input);
          await markDelivering(prepared.exchangeDir);
          recordPromptAdmission(job);
          await savePartialReply(prepared.exchangeDir, job.agentResult.replyText.slice(0, 4));
          sleep(job.replyDelayMs ?? 0);
          await saveReply(prepared.exchangeDir, job.agentResult);
          const completion = await commitCompletion(prepared.exchangeDir, job.agentResult, job.receipt);
          return { exchangeDir: prepared.exchangeDir, inputHash: prepared.inputHash, completion };
        });
        report({ op: job.op, ok: true, ...outcome });
      } catch (error) {
        report({ op: job.op, ok: false, code: error.code ?? null, message: String(error.message) });
      }
      return;
    }

    case 'bump-revision': {
      try {
        const revision = await bumpTopicRevision(job.recordRoot, job.topicId, job.expectedRevision);
        report({ op: job.op, ok: true, revision });
      } catch (error) {
        report({ op: job.op, ok: false, code: error.code ?? null, message: String(error.message) });
      }
      return;
    }

    case 'abandon-index-lock': {
      // Takes the short index lock through the product primitive and dies
      // without releasing it, the way a killed process would.
      const held = await acquireStoreLock(job.recordRoot, 'index');
      writeFileSync(job.readyFile, String(process.pid), 'utf8');
      report({ op: job.op, acquired: true, released: false, lock_path: held.path });
      process.exit(0);
      return;
    }

    case 'hold-index-lock': {
      const held = await acquireStoreLock(job.recordRoot, 'index');
      writeFileSync(job.readyFile, String(process.pid), 'utf8');
      sleep(job.holdMs ?? 0);
      held.release();
      report({ op: job.op, acquired: true, released: true });
      return;
    }

    case 'reclaim-and-hold-index-lock': {
      // Clears whatever dead lock is there, takes a live one of its own, and
      // stays alive holding it until told to let go.
      await store.recoverStoreLocks(job.recordRoot);
      const held = await acquireStoreLock(job.recordRoot, 'index');
      writeFileSync(job.readyFile, JSON.stringify({ pid: process.pid, owner_nonce: held.owner_nonce, path: held.path }, null, 2), 'utf8');
      const until = Date.now() + (job.maxHoldMs ?? 30000);
      while (!existsSync(job.releaseFile) && Date.now() < until) sleep(25);
      const released = held.release();
      writeFileSync(`${job.readyFile}.finish`, JSON.stringify({ pid: process.pid, released: released.released, reason: released.reason }, null, 2), 'utf8');
      report({ op: job.op, acquired: true, owner_nonce: held.owner_nonce });
      return;
    }

    case 'guarded-delete': {
      const began = Date.now();
      try {
        const outcome = await store.deleteLockIfOwner(job.lockPath, job.expectedNonce, { holdMs: job.holdMs ?? 0, readyFile: job.readyFile ?? null });
        report({ op: job.op, ok: true, result: outcome.result, observed_nonce: outcome.observed_nonce ?? null, elapsed_ms: Date.now() - began });
      } catch (error) {
        report({ op: job.op, ok: false, code: error.code ?? null, message: String(error.message), elapsed_ms: Date.now() - began });
      }
      return;
    }

    default:
      report({ op: job.op, ok: false, code: 'unknown-op' });
      process.exitCode = 64;
  }
}

main().catch((error) => {
  report({ op: job.op, ok: false, code: error.code ?? null, message: String(error.stack ?? error) });
  process.exitCode = 1;
});
