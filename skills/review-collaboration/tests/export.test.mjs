import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const pkg=dirname(dirname(fileURLToPath(import.meta.url)));
const files=[
  'tests/acp-auth.test.mjs',
  'scripts/lib/ArgvLauncher.cs','scripts/lib/build-argv-launcher.ps1','scripts/lib/argv-launcher.mjs','tests/argv-launcher.test.mjs',
  'LICENSE','README.md','SKILL.md','package.json','package-lock.json',
  'references/data-boundaries.md','references/first-connection.md','references/mail-records.md','references/reviewer-discovery.md','references/verification.md',
  'templates/background.md','templates/request.md','templates/handoff.md',
  'scripts/export-clean.ps1','scripts/invoke-process.ps1','scripts/review-mail.mjs','scripts/review-mail.ps1',
  'scripts/lib/ProcessTransport.cs','scripts/lib/LockTransaction.cs','scripts/lib/build-lock-helper.ps1','scripts/lib/windows-lock.mjs','scripts/lib/safe-files.mjs','scripts/lib/mail-contract.mjs','scripts/lib/mail-store.mjs','scripts/lib/reviewer-profile.mjs','scripts/lib/acp-route.mjs','scripts/lib/acp-client.mjs','scripts/lib/mail-exchange.mjs',
  'tests/run-offline.mjs','tests/run-windows.ps1','tests/acp-client.test.mjs','tests/acp-lifecycle.test.mjs','tests/mail-store.test.mjs','tests/mail-exchange.test.mjs','tests/profile-route.test.mjs','tests/safe-files.test.mjs','tests/runner-guard.test.mjs','tests/export.test.mjs',
  'tests/fixtures/acp-fixture.mjs','tests/fixtures/fresh-host.md','tests/fixtures/make-test-route.mjs','tests/fixtures/profile-writer.mjs','tests/fixtures/store-worker.mjs',
].sort();
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'mail-export-'));const src=join(root,'source');mkdirSync(src);
  for(const f of files){const dest=join(src,f);mkdirSync(dirname(dest),{recursive:true});cpSync(join(pkg,f),dest);}
  t.after(()=>{if(process.env.REVIEW_MAIL_TEST_EVIDENCE){const dest=join(process.env.REVIEW_MAIL_TEST_EVIDENCE,root.split(/[\\/]/).at(-1));mkdirSync(dirname(dest),{recursive:true});cpSync(root,dest,{recursive:true});}rmSync(root,{recursive:true,force:true});});
  const dest=join(root,'搬移 copy [01]');return {root,src,dest};
}
function command(f){return ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(f.src,'scripts/export-clean.ps1'),'-SourceRoot',f.src,'-Destination',f.dest];}
function run(f){const r=spawnSync('powershell.exe',command(f),{cwd:tmpdir(),windowsHide:true,shell:false,encoding:'utf8',timeout:20000});assert.ifError(r.error);writeFileSync(join(f.root,'last-output.txt'),r.stdout+r.stderr);return r;}
function walk(root,dir=root){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(root,join(dir,e.name)):[relative(root,join(dir,e.name)).replaceAll('\\','/')]).sort();}
test('T7 X01 X03 exact public set, private exclusion, manifest and document links',t=>{
  const f=fixture(t);for(const p of ['_private/auth.json','node_modules/fake.js','records/letter.md','unlisted.txt']){mkdirSync(dirname(join(f.src,p)),{recursive:true});writeFileSync(join(f.src,p),'synthetic-private-canary');}
  assert.equal(run(f).status,0);
  const manifest=JSON.parse(readFileSync(join(f.dest,'release-manifest.json')));
  assert.deepEqual(manifest.files.map(e=>e.path).sort(),files);assert.deepEqual(walk(f.dest),[...files,'release-manifest.json'].sort());
  for(const entry of manifest.files){assert.equal(hash(join(f.dest,entry.path)),entry.sha256.toLowerCase());assert.equal(hash(join(f.dest,entry.path)),hash(join(f.src,entry.path)));}
  for(const name of files.filter(p=>p.endsWith('.md'))){for(const m of readFileSync(join(f.dest,name),'utf8').matchAll(/\]\(([^)]+)\)/g)){if(/^(https?:|#)/.test(m[1]))continue;const linked=resolve(dirname(join(f.dest,name)),m[1].split('#')[0]);assert.ok(linked.startsWith(f.dest+ '\\')&&existsSync(linked),name+' -> '+m[1]);}}
});
test('T7 X02 existing destination and incomplete source never overwrite or publish',t=>{
  const f=fixture(t);mkdirSync(f.dest);writeFileSync(join(f.dest,'keep.txt'),'keep');assert.notEqual(run(f).status,0);assert.equal(readFileSync(join(f.dest,'keep.txt'),'utf8'),'keep');
  f.dest=join(f.root,'missing-source');rmSync(join(f.src,'SKILL.md'));assert.notEqual(run(f).status,0);assert.equal(existsSync(f.dest),false);
});
test('T7 X02 source changing during export is rejected before publication',async t=>{
  const f=fixture(t),script=join(f.src,'scripts/export-clean.ps1'),ready=join(f.root,'ready'),release=join(f.root,'release');
  // Instrument only our copy with a bounded barrier after its initial snapshot.
  const hook=`[IO.File]::WriteAllText('${ready.replaceAll("'","''")}','ready'); $until=(Get-Date).AddSeconds(10); while(-not (Test-Path -LiteralPath '${release.replaceAll("'","''")}')){if((Get-Date) -gt $until){throw 'test-barrier-timeout'}; Start-Sleep -Milliseconds 25}\n`;
  const text=readFileSync(script,'utf8');assert.ok(text.includes('    $stage = Join-Path'));writeFileSync(script,text.replace('    $stage = Join-Path',hook+'    $stage = Join-Path'));
  const child=spawn('powershell.exe',command(f),{cwd:tmpdir(),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);
  const done=new Promise((yes,no)=>{child.once('exit',yes);child.once('error',no);});
  const start=Date.now();while(!existsSync(ready)){if(Date.now()-start>12000)throw Error('test-barrier-missing');await new Promise(r=>setTimeout(r,30));}
  writeFileSync(join(f.src,'SKILL.md'),'changed during export');writeFileSync(release,'go');assert.notEqual(await done,0);writeFileSync(join(f.root,'race-output.txt'),out);assert.equal(existsSync(f.dest),false);assert.match(out,/source-changed/);
});
test('T7 X02 a staging copy failure cleans only owned staging and publishes nothing',t=>{
  const f=fixture(t),script=join(f.src,'scripts/export-clean.ps1');
  const text=readFileSync(script,'utf8'),point='        Copy-Item -LiteralPath $source.Full -Destination $destinationFile -Force:$false';
  assert.ok(text.includes(point));
  writeFileSync(script,text.replace(point,point+"\n        if($source.Relative -eq 'SKILL.md'){throw 'synthetic-staging-write-failure'}"));
  const marker=join(f.root,'unrelated.txt');writeFileSync(marker,'keep');
  const result=run(f);assert.notEqual(result.status,0);assert.match(result.stderr,/synthetic-staging-write-failure/);
  assert.equal(existsSync(f.dest),false);assert.equal(readFileSync(marker,'utf8'),'keep');
  assert.equal(readdirSync(f.root).some(n=>n.startsWith('.review-integrated-export-')),false);
});
