import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { saveProfile } from '../../scripts/lib/reviewer-profile.mjs';
const [file]=process.argv.slice(2);const args=JSON.parse(readFileSync(file,'utf8'));
writeFileSync(args.ready,String(process.pid));
const until=Date.now()+15000;
while(!existsSync(args.go)){if(Date.now()>until)throw Error('writer-barrier-timeout');await new Promise(r=>setTimeout(r,10));}
try{const revision=await saveProfile(args.root,args.selection,args.expected);writeFileSync(args.result,JSON.stringify({ok:true,revision}));}
catch(e){writeFileSync(args.result,JSON.stringify({ok:false,code:e.code}));process.exitCode=1;}
