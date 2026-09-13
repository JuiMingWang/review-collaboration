// Synthetic ACP endpoint for offline tests.
//
// Deliberately hand-written newline-delimited JSON-RPC: it must NOT use
// @agentclientprotocol/sdk, so that a translation bug in the SDK cannot be
// cancelled out by the same bug on both ends of the test.
//
// It answers a fictional identity and never calls a model. Behaviour is chosen
// with --scenario; the identity only changes the reported agent name, so a core
// that branches on identity will fail the two-identity case.
//
// Usage: node acp-fixture.mjs --scenario <name> --identity <name> [--event-log <path>]

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSION = 1;

// The fixture owns these bodies. Tests compare what arrived over the wire with
// the constant imported from here, so a transport that mangles text fails.
export const SCENARIO_BODIES = {
  'auth-required':'Authenticated synthetic reply.', 'auth-failure':'', 'auth-hang':'', 'auth-terminal':'', 'auth-duplicate':'',
  empty:'',refuse:'Synthetic refusal.',limit:'Synthetic partial answer.',
  malformed:'', 'wrong-session':'Wrong session body.', 'version-mismatch':'',
  'replay-on-load':'Only the new reply.', 'resume-missing':'',
  config:'Configured reply.', 'config-no-category':'Configured reply.', 'config-change':'Changed configuration reply.',
  'config-before-prompt':'Should not be prompted.',
  permission:'Permission checks completed.', 'die-after-prompt':'', 'ignore-cancel':'Initial partial.',
  'echo-input':'', 'no-response-init':'',
  'hold-until-file':'Reply after explicit test release.',
  mode:'Mode reply.', 'mode-no-ack':'Mode reply.', 'legacy-model':'Model reply.',
  'wrong-load-session':'', 'config-load':'Configured new reply.',
  echo: 'synthetic reply from the offline fixture.',
  // Multi-byte characters and newlines on purpose: the fixture writes this out
  // in small byte chunks that cut through the middle of UTF-8 sequences.
  'utf8-split': [
    '第一行：這是繁體中文的回信正文。',
    '',
    'Second line mixes ASCII with 中文 and an emoji 🐉 plus 🪁 at the end.',
    '',
    '第三行包含引號「測試」與反斜線 \\ 與 $() 與 `backtick`，全部都應該原樣保留。',
    '',
    '   末行前有空白縮排，行尾也有空白   ',
    '最後一行沒有換行符號結尾。',
  ].join('\n'),
  'late-after-cancel': 'chunk before cancel.',
  'hang-with-child': 'never sent',
  'reply-with-held-pipes': 'Final reply before descendant cleanup.',
};

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const scenario = argValue('--scenario') ?? 'echo';
const identity = argValue('--identity') ?? 'fixture-unnamed';
const eventLog = argValue('--event-log');

if (!Object.prototype.hasOwnProperty.call(SCENARIO_BODIES, scenario)) {
  process.stderr.write(`unknown-scenario:${scenario}\n`);
  process.exit(64);
}

let promptCount = 0;
let authenticated = false;
const authId = argValue('--auth-id') ?? 'synthetic-login';
let cancelCount = 0;
let modelValue='basic',thinkingValue='small';
function configOptions(){return [
  {id:'model-choice',name:'Model',type:'select',...(scenario==='config-no-category'?{}:{category:'model'}),currentValue:modelValue,options:[{value:'basic',name:'Basic'},{value:'advanced',name:'Advanced'}]},
  {id:'thinking-choice',name:'Thinking',type:'select',...(scenario==='config-no-category'?{}:{category:'thought_level'}),currentValue:thinkingValue,options:(modelValue==='advanced'?['deep','medium']:['small']).map(value=>({value,name:value}))},
];}
const serverReplies=new Map();let serverRequest=10000;
function ask(method,params,callback){const id=++serverRequest;serverReplies.set(id,callback);send({jsonrpc:'2.0',id,method,params});}

function logEvent(event) {
  if (!eventLog) return;
  appendFileSync(eventLog, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', 'utf8');
}

// Writes raw bytes in small pieces so multi-byte characters are split across
// chunk boundaries. This is what A02 exercises.
function writeChunked(bytes, chunkSize) {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    process.stdout.write(bytes.subarray(offset, offset + chunkSize));
  }
}

function send(message, chunkSize) {
  const bytes = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
  if (chunkSize) writeChunked(bytes, chunkSize);
  else process.stdout.write(bytes);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function notify(method, params, chunkSize) {
  send({ jsonrpc: '2.0', method, params }, chunkSize);
}

function sendBodyAsChunks(sessionId, body, pieces, chunkSize) {
  const size = Math.max(1, Math.ceil(body.length / pieces));
  for (let offset = 0; offset < body.length; offset += size) {
    notify(
      'session/update',
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: body.slice(offset, offset + size) },
        },
      },
      chunkSize,
    );
  }
}

// hang-with-child: build a process tree the Windows Job must clean up, then
// stop answering so the caller hits its timeout.
function spawnDescendants() {
  const grandchildSource =
    'setInterval(() => {}, 1000); process.stdout.write("grandchild-alive\\n");';
  const childSource =
    'const { spawn } = require("node:child_process");' +
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], ` +
    '{ stdio: "ignore", windowsHide: true });' +
    'process.stdout.write("child-spawned-" + g.pid + "\\n");' +
    'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', childSource], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    shell: false,
  });
  // The child reports the grandchild pid so the Windows suite can assert that
  // the whole tree, not just the direct child, was terminated.
  child.stdout.on('data', (chunk) => {
    const match = /child-spawned-(\d+)/.exec(String(chunk));
    if (match) logEvent({ event: 'grandchild-spawned', grandchild_pid: Number(match[1]) });
  });
  logEvent({ event: 'descendants-spawned', fixture_pid: process.pid, child_pid: child.pid });
  return child;
}

function handle(message) {
  const { id, method, params } = message;
  if(!method){const callback=serverReplies.get(id);if(callback){serverReplies.delete(id);callback(message);}return;}
  logEvent({ event: 'request', method, has_id: id !== undefined, ...(method.startsWith('session/set_')?{params}:{}) });

  switch (method) {
    case 'initialize':
      if(scenario==='no-response-init')return;
      result(id, {
        protocolVersion: scenario==='version-mismatch'?999:PROTOCOL_VERSION,
        agentCapabilities: { loadSession: ['replay-on-load','resume-missing','wrong-load-session','config-load'].includes(scenario), promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: scenario.startsWith('auth-')
          ? [{id:authId,name:'Synthetic login',...(scenario==='auth-terminal'?{type:'terminal',args:['--login']}:{})},...(scenario==='auth-duplicate'?[{id:authId,name:'Duplicate login'}]:[])]
          : [{id:'synthetic-auth',name:'synthetic-secret-account-marker'}],
        _meta: { fixtureIdentity: identity },
      });
      return;

    case 'authenticate':
      logEvent({event:'authenticate-received',params});
      if(scenario==='auth-hang')return;
      if(scenario==='auth-failure'||params.methodId!==authId){send({jsonrpc:'2.0',id,error:{code:-32000,message:'synthetic-private-token-MUST-NOT-ESCAPE'}});return;}
      authenticated=true;result(id,{});return;

    case 'session/new':
      logEvent({event:'session-new-received',params});
      if(scenario.startsWith('auth-')&&!authenticated){send({jsonrpc:'2.0',id,error:{code:-32000,message:'Authentication required'}});return;}
      result(id, { sessionId: `fixture-session-${identity}`, ...(scenario.startsWith('config')?{configOptions:configOptions()}:{}),
        ...(scenario.startsWith('mode')?{modes:{currentModeId:'small',availableModes:[{id:'small',name:'Small'},{id:'deep',name:'Deep'}]}}:{}),
        ...(scenario==='legacy-model'?{models:{currentModelId:'basic',availableModels:[{modelId:'basic',name:'Basic'},{modelId:'advanced',name:'Advanced'}]}}:{}) });
      return;

    case 'session/load':
      if(scenario==='resume-missing'){send({jsonrpc:'2.0',id,error:{code:-32001,message:'synthetic session missing'}});return;}
      if(scenario==='config-load')notify('session/update',{sessionId:params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:configOptions()}});
      if(scenario==='wrong-load-session'){sendBodyAsChunks('wrong-session','other history',1,0);result(id,{});return;}
      sendBodyAsChunks(params.sessionId,'HISTORICAL REPLAY MUST NOT ENTER NEW REPLY',1,0);
      result(id,{});return;

    case 'session/set_mode':
      if(scenario!=='mode-no-ack')notify('session/update',{sessionId:params.sessionId,update:{sessionUpdate:'current_mode_update',currentModeId:params.modeId}});
      result(id,{});return;

    case 'session/set_model':
      result(id,{models:{currentModelId:params.modelId,availableModels:[{modelId:'basic',name:'Basic'},{modelId:'advanced',name:'Advanced'}]}});return;

    case 'session/set_config_option':
      if(params.configId==='model-choice'){modelValue=params.value;thinkingValue='medium';}
      if(params.configId==='thinking-choice')thinkingValue=params.value;
      result(id,{configOptions:configOptions()});
      if(scenario==='config-before-prompt')setTimeout(()=>{modelValue='basic';notify('session/update',{sessionId:params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:configOptions()}});},25);
      return;

    case 'session/prompt': {
      promptCount += 1;
      // Record what actually arrived, not just that something arrived: without
      // this a caller that substitutes the text would look identical here.
      const receivedBlocks = Array.isArray(params?.prompt) ? params.prompt : null;
      const receivedText = receivedBlocks
        ? receivedBlocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        : null;
      logEvent({
        event: 'prompt',
        count: promptCount,
        session_id: params?.sessionId,
        received_blocks: receivedBlocks,
        received_text: receivedText,
        received_bytes: receivedText === null ? null : Buffer.byteLength(receivedText, 'utf8'),
        received_sha256:
          receivedText === null ? null : createHash('sha256').update(receivedText, 'utf8').digest('hex'),
      });
      const sessionId = params?.sessionId;
      const body = scenario==='echo-input'?receivedText:SCENARIO_BODIES[scenario];

      if(scenario==='die-after-prompt'){process.exit(7);return;}
      if(scenario==='malformed'){process.stdout.write('{invalid json\n');return;}
      if(scenario==='wrong-session'){sendBodyAsChunks('unrelated-session',body,1,0);result(id,{stopReason:'end_turn'});return;}
      if(scenario==='config-change'){modelValue='basic';notify('session/update',{sessionId,update:{sessionUpdate:'config_option_update',configOptions:configOptions()}});}
      if(scenario==='permission'){
        const allowed=argValue('--allowed-file');
        const requests=[{kind:'read',locations:[{path:allowed}]},{kind:'read',locations:[{path:allowed+'.outside'}]},{kind:'execute',locations:[]}];
        const next=()=>{
          if(!requests.length){ask('fs/read_text_file',{sessionId,path:allowed},response=>{logEvent({event:'unsupported-fs',response});sendBodyAsChunks(sessionId,body,1,0);result(id,{stopReason:'end_turn'});});return;}
          const spec=requests.shift();ask('session/request_permission',{sessionId,toolCall:{toolCallId:'synthetic-call',...spec},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Reject once',kind:'reject_once'}]},response=>{logEvent({event:'permission-response',response});next();});
        };next();return;
      }

      if (scenario === 'hang-with-child') {
        sendBodyAsChunks(sessionId,'Partial before hard timeout.',1,0);
        spawnDescendants();
        logEvent({ event: 'hanging-without-response' });
        return; // deliberately never responds
      }

      if(scenario==='reply-with-held-pipes'){
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true,shell:false});
        logEvent({event:'descendants-spawned',fixture_pid:process.pid,child_pid:child.pid});
      }

      if(scenario==='hold-until-file'){
        const timer=setInterval(()=>{if(existsSync(argValue('--release-file'))){clearInterval(timer);sendBodyAsChunks(sessionId,body,1,0);result(id,{stopReason:'end_turn'});}},50);
        return;
      }

      if (scenario === 'late-after-cancel' || scenario === 'ignore-cancel') {
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: body } },
        });
        // Wait for session/cancel, then emit one more chunk before stopping.
        pendingPromptId = id;
        pendingSessionId = sessionId;
        return;
      }

      // 3-byte chunks cut through the middle of 3-byte CJK and 4-byte emoji.
      const chunkSize = scenario === 'utf8-split' ? 3 : 0;
      sendBodyAsChunks(sessionId, body, scenario === 'utf8-split' ? 7 : 1, chunkSize);
      result(id, { stopReason: scenario==='refuse'?'refusal':scenario==='limit'?'max_tokens':'end_turn' });
      logEvent({ event: 'body-sent', sha256: createHash('sha256').update(body, 'utf8').digest('hex'), bytes: Buffer.byteLength(body, 'utf8') });
      return;
    }

    case 'session/cancel': {
      cancelCount += 1;
      logEvent({ event: 'cancel', count: cancelCount });
      if(scenario==='ignore-cancel')return;
      if (pendingPromptId !== null) {
        notify('session/update', {
          sessionId: pendingSessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' late chunk after cancel.' } },
        });
        result(pendingPromptId, { stopReason: 'cancelled' });
        pendingPromptId = null;
      }
      return;
    }

    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method-not-found:${method}` } });
      }
  }
}

let pendingPromptId = null;
let pendingSessionId = null;

function serve() {
  // Append across launches: resetting the log would conceal an accidental resend.
  logEvent({ event: 'started', scenario, identity, pid: process.pid, env_marker:process.env.REVIEW_MAIL_SYNTHETIC_MARKER??null });

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (piece) => {
    buffer += piece;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch (error) {
        logEvent({ event: 'parse-error', detail: String(error && error.message) });
      }
    }
  });
  process.stdin.on('end', () => {
    logEvent({ event: 'stdin-end', prompt_count: promptCount, cancel_count: cancelCount });
    if (!['hang-with-child','reply-with-held-pipes'].includes(scenario)) process.exit(0);
  });
}

// Only listen when launched as a process. Tests import SCENARIO_BODIES from
// this file, and an unconditional stdin listener would keep the importing
// process alive forever.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  serve();
}
