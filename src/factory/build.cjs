const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const nativeFs=require('node:fs');
const version=require('./package.json').version;
const sha=file=>new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256'),stream=nativeFs.createReadStream(file);stream.on('data',b=>hash.update(b));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')))});
(async()=>{
 const root=path.resolve(__dirname,'..'),source=path.join(root,'release/4.1.8/智能字幕工厂-win32-x64');
 const target=path.join(root,'release',version,'智能字幕工厂-win32-x64');
 try{await fs.access(target);throw Error('发布目录已存在，拒绝覆盖')}catch(error){if(error.code!=='ENOENT')throw error}
 await fs.access(path.join(source,'智能字幕工厂.exe'));await fs.access(path.join(source,'models/Hy-MT2-1.8B-Q4_K_M.gguf'));
 // Copy the verified complete runtime, including the branded executable. No user data is included.
 await fs.cp(source,target,{recursive:true,filter:file=>!path.relative(source,file).replaceAll('\\','/').startsWith('resources/app')});
 const excluded=new Set(['qa','runtime','__pycache__','build.cjs','aux_worker.py','native_cache.py','presets.js']);
 await fs.cp(__dirname,path.join(target,'resources/app'),{recursive:true,filter:file=>!excluded.has(path.relative(__dirname,file).split(path.sep)[0])});
 const python=['local_asr.py','media_probe.py','factory_worker.py','recognition_quality.py','recognition_complete.py','recognition_checkpoint.py','recognition_refine.py'];
 for(const name of python)await fs.copyFile(path.join(__dirname,name),path.join(target,'resources',name));
 const ruleFiles=['字幕工厂收束规则说明.txt','本机识别收束规则.txt','云端识别收束规则.txt','本机翻译收束规则.txt','云端翻译收束规则.txt'];
 for(const name of [...ruleFiles,'使用说明.md','CHANGELOG.md'])await fs.copyFile(path.join(__dirname,name),path.join(target,name));
 await fs.copyFile(path.join(__dirname,'VERSION'),path.join(target,'软件版本.txt'));
 const hashes={};
 for(const name of await fs.readdir(__dirname))if(/\.(cjs|js|py|html|css|json)$/.test(name)&&!excluded.has(name))hashes[name]=await sha(path.join(target,'resources/app',name));
 for(const name of await fs.readdir(path.join(__dirname,'assets')))hashes['assets/'+name]=await sha(path.join(target,'resources/app/assets',name));
 for(const name of ruleFiles)hashes[name]=await sha(path.join(target,'resources/app',name));
 const previous=JSON.parse(await fs.readFile(path.join(source,'release-manifest.json'),'utf8'));
 require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-Command',"Invoke-Expression ([IO.File]::ReadAllText('"+path.join(__dirname,'qa/brand-417.ps1').replaceAll("'","''")+"',[Text.Encoding]::UTF8))"],{stdio:'inherit',windowsHide:true,env:{...process.env,SUBTITLE_FACTORY_SOURCE:__dirname,SUBTITLE_FACTORY_VERSION:version}});
 const manifest={...previous,version,baseRelease:'4.1.8',repairRevision:1,builtAt:new Date().toISOString(),
  asr:'Whisper Small+Aliyun Beijing '+version,rules:'recognition-local-v5+recognition-cloud-v2+translation-local-v13+translation-cloud-v4',
  localTranslation:'source-aware-meta-v3+local-source-anomaly-v1+semantic-gate-v1+translation-only-omission-v3+close-repeat-v1+cache-schema15',
  cloudTranslation:'source-aware-meta-v1+per-cue-content-retry-v2+internal-repeat-v1+sparse-proof-v2+cache-schema8',
  reliability:[...new Set((previous.reliability+'+cloud-terminal-consistency-v1+queue-continues-after-content-omission-v1').split('+'))].join('+'),
  translationModelSha256:await sha(path.join(target,'models/Hy-MT2-1.8B-Q4_K_M.gguf')),executableSha256:await sha(path.join(target,'智能字幕工厂.exe')),hashes,ruleFiles};
 await fs.writeFile(path.join(target,'release-manifest.json'),JSON.stringify(manifest,null,2));
 console.log(target);
})().catch(error=>{console.error(error);process.exitCode=1});









