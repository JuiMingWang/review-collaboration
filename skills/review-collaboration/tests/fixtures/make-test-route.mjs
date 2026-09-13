// A synthetic test route, not authorization or certification of a real agent.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fingerprintRoute} from '../../scripts/lib/acp-route.mjs';
import {sha256Hex} from '../../scripts/lib/mail-contract.mjs';
const {directory,fixture,scenario,event_log}=JSON.parse(readFileSync(0,'utf8').replace(/^\uFEFF/,''));
const route={schema_version:1,route_id:randomUUID(),reviewer_tool_id:'fixture-orchid',kind:'acp',launch:{executable:process.execPath,arguments:[fixture,'--scenario',scenario,'--identity','fixture-orchid','--event-log',event_log]},source:{url:'https://example.org/synthetic-endpoint',revision:'fixture',manifest_sha256:sha256Hex(readFileSync(fixture))},configuration:[],material_control:{status:'unverified',evidence_ref:null},verification:{level:'discovered',evidence_ref:null}};
route.fingerprint=fingerprintRoute(route);
const material=join(directory,'material.json');writeFileSync(material,JSON.stringify({schema_version:1,route_fingerprint:route.fingerprint,scope:'text-and-listed-snapshots',startup_control:'Synthetic endpoint; no installed agent.',tool_control:'Fixture source only; no account or model.',sources:['https://example.org/synthetic-endpoint'],synthetic_only:true}));
route.material_control={status:'verified',evidence_ref:material,evidence_sha256:sha256Hex(readFileSync(material))};
writeFileSync(join(directory,'route.json'),JSON.stringify(route));
