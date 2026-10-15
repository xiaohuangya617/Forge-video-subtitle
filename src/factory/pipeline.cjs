const fs=require('node:fs/promises'),path=require('node:path');const sub=require('./subtitles.cjs');const {translate,digest}=require('./translation.cjs');const {LocalServer,findModel}=require('./local_server.cjs');const {Recognizer,probe}=require('./recognition.cjs');const {CloudRecognizer}=require('./cloud_asr.cjs');
function formatDuration(minutes){const n=Math.max(0,Math.ceil(Number(minutes)||0));if(n<1)return '少于 1 分钟';const hours=Math.floor(n/60),rest=n%60;return hours?`${hours} 小时${rest?` ${rest} 分钟`:''}`:`${n} 分钟`}
function formatBytes(bytes){const n=Math.max(0,Number(bytes)||0);if(n<1024*1024)return `${Math.ceil(n/1024)} KB`;if(n<1024**3)return `${(n/1024**2).toFixed(1)} MB`;return `${(n/1024**3).toFixed(2)} GB`}
const escapeRegExp=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const videoExtensions=new Set(['mp4','mkv','mov','avi','webm']);
async function expandVideoInput(input,signal){
 const root=path.resolve(String(input));
 const stat=await fs.stat(root).catch(()=>null);
 if(!stat)throw Error('路径不存在');
 if(stat.isFile())return [root];
 if(!stat.isDirectory())throw Error('路径不是文件或文件夹');
 const found=[];
 const walk=async dir=>{
  if(signal?.aborted)throw signal.reason||Error('任务已取消');
  let entries;
  try{entries=await fs.readdir(dir,{withFileTypes:true})}catch(error){throw Error(`无法读取文件夹：${error.message}`)}
  entries.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  for(const entry of entries){
   if(signal?.aborted)throw signal.reason||Error('任务已取消');
   const child=path.join(dir,entry.name);
   if(entry.isDirectory())await walk(child);
   else if(entry.isFile()&&videoExtensions.has(path.extname(entry.name).slice(1).toLowerCase()))found.push(child);
  }
 };
 await walk(root);
 if(!found.length)throw Error('文件夹内没有支持的视频');
 return found;
}
async function readArtifact(file,{allowEmpty=false}={}){try{const cues=await sub.read(file,{allowEmpty});const stat=await fs.stat(file);return {file,cues,mtime:stat.mtimeMs,contentDigest:digest(await fs.readFile(file,'utf8'))}}catch{return null}}
const samePath=(a,b)=>!!a&&!!b&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
async function mediaIdentity(file){
 const identity={path:path.resolve(file)};
 try{const stat=await fs.stat(file);identity.size=stat.size;identity.mtimeMs=stat.mtimeMs}catch{}
 return identity;
}
function sameMedia(a,b){
 return samePath(a?.path,b?.path)&&['size','mtimeMs'].every(key=>a[key]==null||b[key]==null||a[key]===b[key]);
}
function completionFile(task,source){
 const base=path.parse(task.path).name;
 return path.join(path.dirname(source),sub.safeName(base+'-产物'),'.完成记录',digest(path.resolve(source))+'.json');
}
async function readCompletion(task,source,{verifyDigest=true}={}){
 try{
  const row=JSON.parse(await fs.readFile(completionFile(task,source),'utf8'));
  if(!samePath(row.source,source)||verifyDigest&&row.sourceDigest!==digest(await fs.readFile(source,'utf8')))return null;
  return row;
 }catch{return null}
}
async function hasRecognitionCompletion(task,dir,base,sourceFile){
 if(await readCompletion(task,sourceFile))return true;
 return task.source===sourceFile&&!!task.recognitionHash&&!!task.sourceDigest&&
  task.sourceDigest===digest(await fs.readFile(sourceFile,'utf8'));
}
async function saveCompletion(task,translationComplete=false){
 const previous=await readCompletion(task,task.source,{verifyDigest:false});
 const history=previous?.translationHistory||[];
 if(previous?.translation&&!history.some(row=>samePath(row.file,previous.translation)))history.push({
  file:previous.translation,sourceDigest:previous.sourceDigest,translationDigest:previous.translationDigest,
  allowMissingTranslation:previous.allowMissingTranslation===true,translationMode:previous.translationMode});
  const value={version:'4.1.8',revision:1,taskId:task.id,media:task.mediaIdentity||await mediaIdentity(task.path),
  source:task.source,sourceDigest:task.sourceDigest,translationHistory:history,
  recognitionHash:task.recognitionHash||'',recognitionMode:task.recognitionMode||'external',
  translationComplete,translation:translationComplete?task.translation||'':'',
  translationMode:task.translationMode||'',allowMissingTranslation:translationComplete&&['local','cloud'].includes(task.translationMode),time:new Date().toISOString()};
 if(value.translation)value.translationDigest=digest(await fs.readFile(value.translation,'utf8'));
 await sub.atomic(completionFile(task,task.source),value);
}
async function collectArtifacts(dir,base,suffix,explicit=''){
 const files=[];const add=file=>{if(file&&!files.includes(file))files.push(file)};if(explicit)add(explicit);
 try{const re=new RegExp('^'+escapeRegExp(base)+'\\.'+escapeRegExp(suffix)+'(?: \\(\\d+\\))?\\.srt$','i');for(const name of await fs.readdir(dir)){if(re.test(name))add(path.join(dir,name))}}catch{}
 const out=[];for(const file of files){const item=await readArtifact(file,{allowEmpty:true});if(item)out.push(item)}return out.sort((a,b)=>b.mtime-a.mtime)
}
async function findGeneratedArtifacts(task,dir,language,knownTasks=[]){
 const dirs=[...new Set([dir,...[task.source,task.translation].filter(p=>p&&path.isAbsolute(p)).map(p=>path.dirname(p))])];
 const base=path.parse(task.path).name,originals=[],translations=[];
 for(const folder of dirs){
  originals.push(...await collectArtifacts(folder,base,'原声',task.source));
  translations.push(...await collectArtifacts(folder,base,'译文',task.translation));
  translations.push(...await collectArtifacts(folder,base,sub.safeName(language||'中文'),task.translation));
 }
 const identity=await mediaIdentity(task.path),seen=new Set(),valid=[],translationOwners=new Map();
 for(const item of originals.sort((a,b)=>Number(b.file===task.source)-Number(a.file===task.source)||b.mtime-a.mtime)){
  if(seen.has(item.file))continue;seen.add(item.file);
  const raw=await readCompletion(task,item.file,{verifyDigest:false});
  const records=[...(raw?.translationHistory||[]),...(raw?.translation?[{
   file:raw.translation,sourceDigest:raw.sourceDigest,translationDigest:raw.translationDigest,
   allowMissingTranslation:raw.allowMissingTranslation===true,translationMode:raw.translationMode}]:[])];
  for(const record of records){
   const key=path.resolve(record.file).toLowerCase(),owners=translationOwners.get(key)||[];
   owners.push({...record,source:item.file});translationOwners.set(key,owners);
  }
  if(raw?.media&&!sameMedia(raw.media,identity))continue;
  const bindings=knownTasks.filter(t=>samePath(t.source,item.file));
  if(!raw?.media&&bindings.some(t=>!samePath(t.path,task.path)))continue;
  const bound=samePath(task.source,item.file)||bindings.some(t=>samePath(t.path,task.path));
  if(raw&&!raw.media&&!bound)continue;
  if(bound&&task.mediaIdentity&&!sameMedia(task.mediaIdentity,identity))continue;
  const marker=await readCompletion(task,item.file);
  if(!item.cues.length&&!marker&&!await hasRecognitionCompletion(task,dir,base,item.file))continue;
  const owner=bindings.find(t=>samePath(t.path,task.path));
  valid.push({...item,marker,raw,identity,recognitionMode:raw?.recognitionMode||owner?.recognitionMode||
   (samePath(task.source,item.file)?task.recognitionMode:'')||'external'});
 }
 const result=(source,extra={})=>({source:source.file,sourceCues:source.cues,translation:'',emptyComplete:false,
  marker:source.marker,recognitionMode:source.recognitionMode,mediaIdentity:source.identity,...extra});
 for(const source of valid){
  const marker=source.marker;
  if(!source.cues.length){
   let translation='';
   if(marker?.translation&&marker.translationDigest===await fs.readFile(marker.translation,'utf8').then(digest).catch(()=>null))translation=marker.translation;
   return result(source,{translation,emptyComplete:true});
  }
  const candidates=translations.sort((a,b)=>Number(b.file===task.translation)-Number(a.file===task.translation)||b.mtime-a.mtime);
  for(const translated of candidates){
   try{
    const owners=translationOwners.get(path.resolve(translated.file).toLowerCase())||[];
    if(owners.length&&!owners.some(row=>samePath(row.source,source.file)&&
     row.sourceDigest===source.contentDigest))continue;
    if(!owners.length&&source.raw&&!source.marker)continue;
    if(!owners.length&&knownTasks.some(t=>samePath(t.translation,translated.file)&&
     (!samePath(t.path,task.path)||!samePath(t.source,source.file))))continue;
    const owner=owners.find(row=>samePath(row.source,source.file)&&row.sourceDigest===source.contentDigest);
    const mode=owner?.translationMode||marker?.translationMode||task.translationMode;
    const allowMissing=['local','cloud'].includes(mode)&&owner?.allowMissingTranslation===true;
    if(!translated.cues.length&&(!allowMissing||owner.translationDigest!==translated.contentDigest))continue;
    const paired=sub.pair(source.cues,translated.cues,{allowMissing,byTime:true});
    if(mode==='local'&&paired.some(c=>c.text&&
     (!require('./translation.cjs').acceptableLocalChinese(c.text,c.original)||require('./translation.cjs').localQualityIssue(c.text,c.original))))continue;
    if(mode==='cloud'&&paired.some(c=>c.text&&require('./translation.cjs').cloudQualityIssue(c.text,c.original,language)))continue;
    return result(source,{translation:translated.file,translationCues:translated.cues,translationMode:mode});
   }catch{}
  }
 }
 return valid[0]?result(valid[0]):null;
}
class Pipeline{
 constructor({resources,appDir,dataDir,emit,translateFn=translate,RecognizerClass=Recognizer,probeFn=probe,diskCheckFn=null}){Object.assign(this,{resources,appDir,dataDir,emit,translateFn,RecognizerClass,probeFn,diskCheckFn});this.tasks=[];this.running=false;this.writes=Promise.resolve();this.persistenceDegraded=false;this.persistenceFatal=false;}
 async estimate(settings,{force=false}={}){
  await this.syncArtifacts(settings,{notify:false});
   const recognitionEnabled=settings.recognitionEnabled!==false,translationEnabled=settings.translationEnabled!==false,noStage=!recognitionEnabled&&!translationEnabled;
  const queue=force?this.tasks.slice():this.tasks.filter(t=>!t.done||(translationEnabled&&t.recognizedOnly));
   const eligible=noStage?[]:queue.filter(t=>recognitionEnabled||t.source),missing=recognitionEnabled?[]:queue.filter(t=>!t.source);
  const per120={local:{recognition:40,translation:35},cloud:{recognition:6,translation:4}};
  let minutes=0,totalFinal=0,tempPeak=0;
  for(const task of eligible){
   const fraction=Math.max(0,Number(task.duration)||0)/7200;
   const size=await fs.stat(task.path).then(s=>Number(s.size)||0).catch(()=>0);
   if(recognitionEnabled&&(force||!task.source))minutes+=fraction*per120[settings.recognitionMode==='cloud'?'cloud':'local'].recognition;
   if(translationEnabled)minutes+=fraction*per120[settings.translationMode==='cloud'?'cloud':'local'].translation;
   totalFinal+=Math.max(128*1024,Math.min(8*1024*1024,size*.002));
   tempPeak=Math.max(tempPeak,Math.max(256*1024*1024,size*.02));
  }
  const estimatedBytes=(totalFinal+tempPeak)*1.05;
  let availableBytes=null;
  const roots=[...new Set(eligible.map(t=>path.parse(settings.genDir||path.dirname(t.path)).root).concat(path.parse(this.dataDir).root))];
  if(typeof fs.statfs==='function'){
   const values=[];
   for(const root of roots){try{const stat=await fs.statfs(root),free=Number(stat.bavail)*Number(stat.bsize);if(Number.isFinite(free))values.push(free)}catch{}}
   if(values.length)availableBytes=Math.min(...values);
  }
  const spaceEnough=availableBytes!=null&&availableBytes>=estimatedBytes;
  return {tasks:eligible,taskCount:eligible.length,missingCount:missing.length,recognitionMode:settings.recognitionMode,
   translationMode:settings.translationMode,recognitionEnabled,translationEnabled,
   estimatedMinutes:Math.ceil(minutes),estimatedTimeText:formatDuration(minutes),estimatedBytes,
   estimatedSpaceText:formatBytes(estimatedBytes),availableBytes,
   availableSpaceText:availableBytes==null?'无法读取':formatBytes(availableBytes),spaceEnough,
   // Missing-source items are handled as per-task failures by start(). They
   // must not prevent eligible items from entering the queue.
    reason:noStage?'请至少启用识别或翻译':!eligible.length&&missing.length?`有 ${missing.length} 个任务没有原声字幕，无法仅翻译`:
    availableBytes==null?'无法读取可用磁盘空间':spaceEnough?'':'可用磁盘空间不足',
   warning:missing.length&&eligible.length?`有 ${missing.length} 个任务没有原声字幕，将标记失败并继续后续任务`:''};
 }
 async readTaskFile(file){try{const data=JSON.parse(await fs.readFile(file,'utf8'));return Array.isArray(data)?data:null}catch{return null}}
 async init(){
  const main=path.join(this.dataDir,'tasks.json'),backup=main+'.bak';
  let data=await this.readTaskFile(main),chosen=main,recoveredFrom='';
  if(!data){data=await this.readTaskFile(backup);chosen=backup;if(data)recoveredFrom=backup}
  const savedAt=data?await fs.stat(chosen).then(stat=>stat.mtimeMs).catch(()=>0):0;
  try{
   const lines=(await fs.readFile(path.join(this.dataDir,'tasks-recovery.jsonl'),'utf8')).trim().split(/\r?\n/).filter(Boolean);
   for(let i=lines.length-1;i>=0;i--){
    let row;try{row=JSON.parse(lines[i])}catch{continue}
    if(!Array.isArray(row.tasks))continue;
    if(!data||Date.parse(row.time)>savedAt){data=row.tasks;recoveredFrom='tasks-recovery.jsonl'}
    break;
   }
  }catch{}
  if(data){
   this.tasks=data.filter(t=>t&&typeof t.id==='string'&&typeof t.path==='string').map(t=>({...t,status:['识别中','翻译中','等待执行'].includes(t.status)?'已中断，可重试':t.status}));
   if(recoveredFrom)await this.log(`任务记录已从 ${recoveredFrom} 恢复`);
  }else{
   try{await fs.access(main);await this.log('任务记录无法读取，已从空队列启动')}catch(e){if(e.code!=='ENOENT')await this.log('任务记录无法读取')}
  }
  return this.tasks;
 }
 async syncArtifacts(settings,{notify=true}={}){
  let changed=false;
  for(const task of this.tasks){
   try{
    if(task.forcePending||task.translationRedoPending)continue;
    const artifacts=await findGeneratedArtifacts(task,settings.genDir||path.dirname(task.path),settings.language||'中文',this.tasks);
    let next;
    if(artifacts?.source){
     const complete=!!artifacts.translation||artifacts.emptyComplete;
     next={source:artifacts.source,sourceDigest:digest(await fs.readFile(artifacts.source,'utf8')),
      translation:artifacts.translation||'',language:task.language||settings.language||'中文',
      recognitionMode:artifacts.recognitionMode,mediaIdentity:artifacts.mediaIdentity,
      recognitionHash:artifacts.marker?.recognitionHash||task.recognitionHash||'',
      translationMode:artifacts.translation?artifacts.translationMode||artifacts.marker?.translationMode||task.translationMode||'':task.translationMode||'',
      recognizedOnly:!complete,done:true,
      status:artifacts.emptyComplete?'已完成（无有效对白）':complete?(task.qualityPending?'已完成（含待复核）':'已完成'):'已识别，待翻译',error:''};
    }else next={source:'',translation:'',sourceDigest:'',done:false,recognizedOnly:false,status:'等待执行'};
    for(const [key,value]of Object.entries(next))if(JSON.stringify(task[key])!==JSON.stringify(value)){task[key]=value;changed=true}
    if(artifacts?.source&&!artifacts.marker?.media)await saveCompletion(task,!!artifacts.translation||artifacts.emptyComplete);
   }catch(error){
    Object.assign(task,{done:false,recognizedOnly:false,status:'产物检查失败',error:String(error.message||error)});
    changed=true;await this.log(path.basename(task.path)+' 产物检查失败：'+task.error);
   }
  }
  if(changed){await this.persist();if(notify)this.notify()}
  return changed;
 }
 async log(message){try{await fs.mkdir(this.dataDir,{recursive:true});await fs.appendFile(path.join(this.dataDir,'factory.log'),`[${new Date().toISOString()}] ${message}\n`)}catch{/* 日志是辅助信息；目录不可写时不能反过来阻断任务队列 */}}
 async diagnostic(file,entries){try{await sub.appendJsonl(file,entries)}catch(error){await this.log('诊断写入失败，任务继续：'+error.message)}}
 async writeRecovery(snapshot,error){try{await fs.mkdir(this.dataDir,{recursive:true});await fs.appendFile(path.join(this.dataDir,'tasks-recovery.jsonl'),JSON.stringify({time:new Date().toISOString(),tasks:snapshot,error:String(error?.message||error||'状态写入失败')})+'\n','utf8');return true}catch{return false}}
 async persistSnapshot(snapshot){const file=path.join(this.dataDir,'tasks.json'),tmp=file+'.tmp',backup=file+'.bak';let last;for(let attempt=1;attempt<=2;attempt++){try{await fs.mkdir(this.dataDir,{recursive:true});await fs.writeFile(tmp,JSON.stringify(snapshot,null,2),'utf8');await fs.rename(tmp,file);try{await fs.copyFile(file,backup)}catch{}if(this.persistenceDegraded)this.emit({event:'persistence-recovered',message:'任务状态保存已恢复'});this.persistenceDegraded=false;this.persistenceFatal=false;return true}catch(e){last=e;await fs.rm(tmp,{force:true}).catch(()=>{});if(attempt<2)await new Promise(resolve=>setTimeout(resolve,80*attempt))}}const recoverable=await this.writeRecovery(snapshot,last);this.persistenceDegraded=true;this.persistenceFatal=!recoverable;this.emit({event:'persistence-warning',fatal:!recoverable,message:recoverable?'任务状态写入失败，已写入恢复日志':'任务状态和恢复日志均无法写入，队列将暂停'});await this.log(`任务状态写入失败：${last?.message||last||'未知错误'}`);return false}
 persist(){const snapshot=structuredClone(this.tasks);this.writes=this.writes.catch(()=>{}).then(()=>this.persistSnapshot(snapshot));return this.writes}
 async checkDiskAndTargets(settings,queue){if(this.diskCheckFn)return this.diskCheckFn(settings,queue);await fs.mkdir(this.dataDir,{recursive:true});const dirs=new Set();for(const task of queue)dirs.add(settings.genDir||path.dirname(task.path));const roots=[...new Set([...dirs,this.dataDir].map(dir=>path.parse(dir).root))];if(typeof fs.statfs==='function'){for(const root of roots){try{const stat=await fs.statfs(root);const free=Number(stat.bavail)*Number(stat.bsize);if(Number.isFinite(free)&&free<512*1024*1024)throw Error(`磁盘可用空间不足：${root}`)}catch(e){if(String(e.message||'').includes('磁盘可用空间不足'))throw e}}}return true}
 async diskStatus(settings,queue){const roots=[...new Set(queue.map(task=>path.parse(settings.genDir||path.dirname(task.path)).root).concat(path.parse(this.dataDir).root))];let warning='';for(const root of roots){if(typeof fs.statfs!=='function')continue;try{const stat=await fs.statfs(root),free=Number(stat.bavail)*Number(stat.bsize);if(Number.isFinite(free)&&free<256*1024*1024)throw Object.assign(Error(`磁盘可用空间过低：${root}`),{code:'QUEUE_STOP'});if(Number.isFinite(free)&&free<1024*1024*1024)warning=`磁盘可用空间低于 1 GB：${root}`}catch(e){if(e.code==='QUEUE_STOP')throw e}}return warning}
 async cleanupFiles(files){for(const file of new Set(files||[]))await fs.unlink(file).catch(()=>{})}
 async cleanupTaskResume(task){if(task?.checkpointDir)await fs.rm(task.checkpointDir,{recursive:true,force:true}).catch(()=>{});task.checkpointDir='';}
 notify(extra={}){this.emit({event:'state',tasks:this.tasks,running:this.running,persistenceDegraded:this.persistenceDegraded,...extra})}
 async add(paths){
  if(this.running||this.addController)throw Error('请等待当前操作结束');
  const controller=new AbortController();this.addController=controller;const errors=[];
  try{for(const input of paths){if(controller.signal.aborted)break;let files;
   try{files=await expandVideoInput(input,controller.signal)}catch(e){if(controller.signal.aborted)break;errors.push(`${path.basename(input)}：${e.message}`);continue}
   for(const file of files){if(controller.signal.aborted)break;if(this.tasks.some(t=>t.path.toLowerCase()===file.toLowerCase()))continue;
    try{const r=await this.probeFn(this.resources,this.appDir,file,controller.signal);
     if(controller.signal.aborted)break;if(!r.ok)throw Error(r.message);this.tasks.push({id:require('node:crypto').randomUUID(),path:file,status:'等待执行',done:false,duration:r.duration});
    }catch(e){if(controller.signal.aborted)break;errors.push(`${path.basename(file)}：${e.message}`)}
   }
  }}finally{await this.persist();this.addController=null;this.notify()}return errors;
 }
 async change(action,id){if(this.running)throw Error('运行中不能调整任务');const i=this.tasks.findIndex(t=>t.id===id);if(action==='clear')this.tasks=[];else if(i>=0){if(action==='remove')this.tasks.splice(i,1);else if(action==='up'&&i>0)[this.tasks[i-1],this.tasks[i]]=[this.tasks[i],this.tasks[i-1]];else if(action==='down'&&i<this.tasks.length-1)[this.tasks[i+1],this.tasks[i]]=[this.tasks[i],this.tasks[i+1]];else if(action==='recognize'){this.tasks[i].recognitionGeneration=require('node:crypto').randomUUID();for(const key of ['source','sourceDigest','translation','partial','diagnostics','comparison','reviewFile','recognitionHash','checkpointDir'])this.tasks[i][key]='';this.tasks[i].translationFailures=[];this.tasks[i].reviewCount=0;this.tasks[i].postprocessReviewCount=0;this.tasks[i].sourceCleanup=null;this.tasks[i].translationCleanup=null;this.tasks[i].qualityPending=false;this.tasks[i].warning='';this.tasks[i].forcePending=true;this.tasks[i].forceGeneration=this.tasks[i].recognitionGeneration;this.tasks[i].recognizedOnly=false;this.tasks[i].done=false;this.tasks[i].status='等待重新识别'}else if(action==='redo'){this.tasks[i].cacheGeneration=require('node:crypto').randomUUID();this.tasks[i].translationRedoPending=true;this.tasks[i].translation='';this.tasks[i].done=false;this.tasks[i].status='等待执行'}}await this.persist();this.notify()}
 cancel(){this.controller?.abort(Error('任务已取消'));this.addController?.abort(Error('任务已取消'));return true}
 async start(settings,{force=false}={}){
  if(this.running)throw Error('已有任务运行中');
  const translateEnabled=settings.translationEnabled!==false,recognitionEnabled=settings.recognitionEnabled!==false;
  this.controller=new AbortController();
  const signal=this.controller.signal,started=Date.now();
  this.running=true;this.notify();
  let recognizer=null,localServer=null,currentSend=()=>{},queue=[],queueStopReason='',admissionError='',attempted=0,succeeded=0,failed=0,cancelledCount=0,admitted=false;
  const check=()=>signal.throwIfAborted();
  const queueGuard=()=>{check();if(this.persistenceFatal)throw Object.assign(Error('任务状态无法保存，队列已暂停；请检查磁盘空间和目录权限'),{code:'QUEUE_STOP'})};
  try{
   check();await this.syncArtifacts(settings,{notify:false});check();
   queue=force?this.tasks.slice():this.tasks.filter(t=>!t.done||(translateEnabled&&t.recognizedOnly));
    if(!queue.length)throw Error(this.tasks.length?'任务已完成':'没有待处理任务');
    if(!recognitionEnabled&&!translateEnabled)throw Error('请至少启用识别或翻译');
   // In translation-only mode, a task without an existing source subtitle is
   // a per-task failure. Keep it in the queue so later valid tasks continue.
   // Admission is rejected only when every queued task is missing its source.
   if(!recognitionEnabled&&queue.length&&!queue.some(t=>t.source))
    throw Error('当前任务没有可用原声字幕，无法仅翻译');
   if(translateEnabled&&settings.translationMode==='cloud'&&this.translateFn===translate){
    if(!settings.key?.trim())throw Error('请填写翻译 API Key');
    if(!settings.model?.trim())throw Error('模型名称不能为空');
    require('./translation.cjs').endpoint(settings.baseurl);
   }
   await this.checkDiskAndTargets(settings,queue);queueGuard();admitted=true;
   for(let i=0;i<queue.length;i++){
    queueGuard();
    const diskWarning=await this.diskStatus(settings,queue);queueGuard();
    if(diskWarning)this.emit({event:'disk-warning',message:diskWarning});
    const task=queue[i];attempted++;
    let temporarySource='',lastFraction=0;
    const send=m=>{
     let fraction=task.status==='翻译中'?.75:0;
     if(['progress','coverage-progress','checkpoint-resume'].includes(m.event)&&task.duration)
      fraction=Math.min(translateEnabled?.65:.85,(m.end||0)/task.duration*(translateEnabled?.65:.85));
     if(m.event==='translation')fraction=.75+.25*((m.batch-1+(m.completed||m.cached?1:0))/m.total);
     fraction=Math.max(lastFraction,fraction);lastFraction=fraction;
     this.emit({...m,taskId:task.id,name:path.basename(task.path),queueIndex:i+1,queueTotal:queue.length,overall:Math.floor((i+fraction)/queue.length*100)});
    };
    currentSend=send;
    try{
     task.error='';task.done=false;task.translation='';task.translationFailures=[];task.warning='';
     if(force){
      task.cacheGeneration=require('node:crypto').randomUUID();
      if(recognitionEnabled){
       task.recognitionGeneration=require('node:crypto').randomUUID();
       task.forceGeneration=task.recognitionGeneration;task.forcePending=true;
      }else task.translationRedoPending=true;
      await this.persist();queueGuard();
     }
      const previousIdentity=task.mediaIdentity,previousCheckpoint=task.checkpointDir,previousRecognitionMode=task.recognitionMode;
      const stat=await fs.stat(task.path);check();
      task.mediaIdentity={path:path.resolve(task.path),size:stat.size,mtimeMs:stat.mtimeMs};
     const dir=settings.genDir||path.dirname(task.path),base=path.parse(task.path).name;
     await fs.access(dir);check();
     const productsDir=path.join(dir,sub.safeName(base+'-产物'));
     const recognitionMode=settings.recognitionMode==='cloud'?'cloud':'local';
     const fingerprint=digest({path:task.path,size:stat.size,mtime:stat.mtimeMs,dir,
      engine:'factory-asr-4.1.8',rules:recognitionMode==='local'?'local-asr-v5':'cloud-asr-v2',
      recognitionMode,model:recognitionMode==='local'?'faster-whisper-small':settings.recognitionModel,
      baseurl:recognitionMode==='cloud'?settings.recognitionBaseurl:'',
      prompt:recognitionMode==='cloud'?settings.recognitionPrompt:'',
      generation:task.recognitionGeneration||''});
      let original=null,freshRecognition=false;
     if(!(force&&recognitionEnabled)&&task.source){
      try{
       const parsed=await sub.read(task.source,{allowEmpty:true});
       if(parsed.length||await hasRecognitionCompletion(task,dir,base,task.source))original=parsed;
      }catch{}
     }
     check();
     if(!original){
      if(!recognitionEnabled)throw Error('当前任务没有可用原声字幕，无法仅翻译');
      const previousDiagnostics=task.diagnostics;
      task.status='识别中';task.source='';task.comparison='';task.partial='';task.diagnostics='';
      task.reviewFile='';task.recognitionHash='';task.reviewCount=0;task.postprocessReviewCount=0;
      task.qualityPending=false;task.recognitionMode=recognitionMode;
      await fs.mkdir(productsDir,{recursive:true});check();
      task.checkpointDir=path.join(productsDir,'.字幕工厂断点',digest({id:task.id,fingerprint}));
      if(recognitionMode==='cloud'&&!force&&!task.forcePending&&previousRecognitionMode==='cloud'&&previousCheckpoint&&sameMedia(previousIdentity,task.mediaIdentity)){
       const oldState=path.join(previousCheckpoint,'cloud','.aliyun-task.json');
       if(await fs.stat(oldState).then(()=>true).catch(()=>false))task.checkpointDir=previousCheckpoint;
      }
      // A new force generation cannot reuse a submitted cloud task or an ASR checkpoint.
      const cloudStateDir=path.join(task.checkpointDir,'cloud');
      if(recognitionMode==='cloud'&&!force&&previousDiagnostics){
       const stateFile=path.join(cloudStateDir,'.aliyun-task.json');
       let state;try{state=JSON.parse(await fs.readFile(stateFile,'utf8'))}catch{}
       if(state?.status==='FAILED'&&state.terminalConfirmed===undefined&&state.taskId){
        const evidence=await fs.readFile(previousDiagnostics,'utf8').catch(()=>'');
        const confirmed=evidence.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
         .find(row=>row.event==='cloud-poll-failed'&&row.taskId===state.taskId&&['FAILED','CANCELED'].includes(row.status));
        if(confirmed)await sub.atomic(stateFile,{...state,status:confirmed.status,terminalConfirmed:true,failureReason:confirmed.message||''});
       }
      }
      if(recognitionMode==='cloud'&&!force){
       const legacyFile=path.join(productsDir,'.aliyun-task.json');
       let legacy;try{legacy=JSON.parse(await fs.readFile(legacyFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
       if(legacy){
        const evidence=await fs.readFile(previousDiagnostics||'','utf8').catch(()=>'');
        const rows=evidence.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
        const belongs=legacy.taskId?rows.some(row=>row.taskId===legacy.taskId):rows.some(row=>row.event==='cloud-submit-start');
        const current=path.join(cloudStateDir,'.aliyun-task.json');
        if(!await fs.stat(current).then(()=>true).catch(()=>false)){
         if(!belongs)throw Error('发现旧云端任务状态但无法确认归属；为避免重复计费，本项未重新提交');
         await sub.atomic(current,legacy);
        }
       }
      }
      const target=await sub.reservePath(dir,base+'.原声.srt');
      temporarySource=path.join(productsDir,'.recognition-'+require('node:crypto').randomUUID()+'.srt');
      task.partial=await sub.reservePath(productsDir,base+'.未完成-'+require('node:crypto').randomUUID().slice(0,8)+'.srt');
      task.diagnostics=await sub.reserve(productsDir,base+'.识别诊断.jsonl');
      await this.diagnostic(task.diagnostics,[{event:'recognition-run',version:'4.1.8',route:recognitionMode+'-asr',stage:'recognition',recognitionMode,
       fingerprint,checkpointDir:task.checkpointDir,force:force&&recognitionEnabled,generation:task.recognitionGeneration||''}]);
      await this.persist();queueGuard();this.notify();
      const probeResult=await this.probeFn(this.resources,this.appDir,task.path,signal);check();
      if(!probeResult.ok)throw Error(probeResult.message);
      if(!recognizer||recognizer.dead){
       if(recognizer)await recognizer.close();check();
       recognizer=recognitionMode==='cloud'
        ?new CloudRecognizer(this.resources,this.appDir,this.dataDir,m=>currentSend(m),signal)
        :new this.RecognizerClass(this.resources,this.appDir,path.join(this.resources,'..','models','faster-whisper-small'),
         m=>currentSend(m),signal,{cpuMode:settings.cpuMode});
      }
      const done=await recognizer.run({checkpoint_dir:task.checkpointDir,checkpoint_key:fingerprint,
       media:task.path,name:path.basename(task.path),output:temporarySource,partial_output:task.partial,
       diagnostic_output:task.diagnostics,comparison_output:'',context:'',hotwords:'',dialogue_only:false,
       recognitionSettings:settings,cloud_state_file:path.join(cloudStateDir,'.aliyun-task.json'),
       cloud_result_file:path.join(cloudStateDir,'.aliyun-result.json')});
      check();if(!done)throw Error('识别没有完成事件');
      original=await sub.read(temporarySource,{allowEmpty:true});check();
      await fs.rename(temporarySource,target);temporarySource='';
      task.source=target;task.recognitionHash=fingerprint;task.recognitionTiming=done.timing||null;
       freshRecognition=true;
      task.reviewCount=done.reviewCount||0;
      await this.cleanupFiles([task.partial]);task.partial='';
     }
     check();
      const sourceMode=task.recognitionMode||'external';
      const normalized=freshRecognition?sub.cleanRecognitionCues(original,{mode:sourceMode,minRun:3,maxKeep:2}):{
       cues:original,changed:false,changes:[],noiseRemoved:[],weakRemoved:[],adjacent:{groups:[]},
       weakRemovedCount:0,noiseRemovedCount:0,reviewCount:task.postprocessReviewCount||0,anomalies:[]};
     const cleaned=freshRecognition?sub.renumber(normalized.cues):original;
     task.sourceCleanup={originalCount:original.length,cleanedCount:cleaned.length,
      removedCount:original.length-cleaned.length,weakRemovedCount:normalized.weakRemovedCount,
      internalGroups:normalized.changes.length,noiseRemovedCount:normalized.noiseRemovedCount};
     if(freshRecognition&&(normalized.changed||cleaned.some((c,i)=>c.id!==original[i]?.id))){
      check();await sub.writeAtomicText(task.source,sub.build(cleaned,{allowEmpty:true}));
     }
     original=cleaned;
     task.sourceDigest=digest(await fs.readFile(task.source,'utf8'));
     task.postprocessReviewCount=normalized.reviewCount||0;
     task.qualityPending=Boolean(task.reviewCount||task.postprocessReviewCount);
      if(freshRecognition&&task.diagnostics){
      const event=entry=>({event:'recognition-postprocess',route:sourceMode+'-asr',stage:'recognition',recognitionMode:sourceMode,ruleVersion:'4.1.8',...entry});
      await this.diagnostic(task.diagnostics,[
       ...normalized.changes.map(x=>event({...x,action:x.kind||'collapse-internal-repeat'})),
       ...normalized.noiseRemoved.map(x=>event({...x,action:'remove-noise-description'})),
       ...normalized.weakRemoved.map(x=>event({...x,action:'drop-weak-local-fragment'})),
       ...normalized.adjacent.groups.map(x=>event({...x,action:'remove-adjacent-repeat'})),
       ...normalized.anomalies.map(x=>event({...x,action:'recognition-anomaly'})),
       event({action:'recognition-postprocess-summary',...task.sourceCleanup,sourceDigest:task.sourceDigest})]);
     }
     check();await saveCompletion(task);await this.persist();queueGuard();
     if(!translateEnabled||!original.length){
      task.done=true;task.recognizedOnly=original.length>0;task.forcePending=false;task.forceGeneration='';
      task.status=!original.length?'已完成（无有效对白）':task.qualityPending?'已完成（含待复核）':'已识别，待翻译';
      task.warning=task.qualityPending?'已完成，含待复核，详见诊断。':'';
      await saveCompletion(task,!original.length);
      await this.cleanupTaskResume(task);succeeded++;
      await this.persist();this.notify();continue;
     }
     task.status='翻译中';task.translationMode=settings.translationMode==='local'?'local':'cloud';
     this.notify();await this.persist();queueGuard();
     const localServerOptions={settings,appDir:this.appDir,dataDir:this.dataDir,signal,
      onStatus:m=>this.emit({event:'local-server',...m,taskId:task.id,name:path.basename(task.path),queueIndex:i+1,queueTotal:queue.length})};
     if(task.translationMode==='local'&&this.translateFn===translate){
      const modelPath=await findModel({resources:this.resources,appDir:this.appDir,configured:settings.localModelPath});check();
      if(!modelPath)throw Error('找不到内置 Hy-MT2 模型，请确认发布包的 models 目录完整');
      settings={...settings,localModelPath:modelPath,language:'中文'};localServerOptions.settings=settings;
      if(!localServer)localServer=new LocalServer();
      await localServer.ensure(localServerOptions);check();
     }
     await fs.mkdir(productsDir,{recursive:true});check();
     task.translationDiagnostics=await sub.reserve(productsDir,base+'.翻译诊断.jsonl');
     const cacheFiles=[];
      let translated=await this.translateFn(original,settings,{signal,cacheDir:path.join(this.dataDir,'translation-cache'),
      onProgress:send,cacheGeneration:task.cacheGeneration||'',taskId:task.id,sourceFingerprint:task.sourceDigest,
      recognitionMode:sourceMode,diagnosticFile:task.translationDiagnostics,
      recoverLocalService:localServer?()=>localServer.recover(localServerOptions):undefined,cacheFiles});
     check();
     task.translationFailures=Array.isArray(translated.failures)?translated.failures:[];
     const drops=new Set(translated.droppedIds||[]);
     const sourceIds=new Set(original.map(c=>c.id));
     if([...drops].some(id=>!sourceIds.has(id)))throw Error('翻译丢弃编号不属于当前原声');
     const sourceKept=original.filter(c=>!drops.has(c.id));
     if(sourceKept.length){
      sub.pair(sourceKept,translated);
      if(task.translationMode==='local')for(let n=0;n<translated.length;n++){
       const engine=require('./translation.cjs');
       if(!engine.acceptableLocalChinese(translated[n].text,sourceKept[n].text)||engine.localQualityIssue(translated[n].text,sourceKept[n].text))
        throw Error('本机译文未通过最终质量闸门');
      }
      if(task.translationMode==='cloud')for(let n=0;n<translated.length;n++)if(require('./translation.cjs').cloudQualityIssue(translated[n].text,sourceKept[n].text,settings.language))throw Error('云端译文未通过最终质量闸门');
     }else if(translated.length)throw Error('原声与译文条数不一致');
      if(task.translationMode==='cloud'){
       const cloudRepeatChanges=[];
       translated=translated.map(cue=>{
        const cleaned=sub.cleanCloudTranslationText(cue.text,{minRun:3,maxKeep:2});
        if(cleaned.changed)cloudRepeatChanges.push({cueId:cue.id,source:cue.text,original:cue.text,cleaned:cleaned.text,groups:cleaned.groups,action:'collapse-cloud-internal-repeat'});
        return cleaned.changed?{...cue,text:cleaned.text}:cue;
       });
       await this.diagnostic(task.translationDiagnostics,cloudRepeatChanges.map(change=>({event:'translation-cloud-internal-repeat',mode:'cloud',route:'cloud-translation',stage:'translation',ruleVersion:'4.1.8',...change})));
      }
      const repeated=sub.cleanTranslationRepeats(translated,{source:original,maxGapMs:1500});
     for(const cue of repeated.removed)drops.add(cue.id);
      await this.diagnostic(task.translationDiagnostics,repeated.groups.map(group=>({event:'translation-repeat-cleaned',mode:task.translationMode,route:task.translationMode+'-translation',stage:'translation',ruleVersion:'4.1.8',...group})));
     const finalTranslation=sub.renumber(repeated.cues);
     if(drops.size){
      await this.diagnostic(task.translationDiagnostics,original.filter(c=>drops.has(c.id)).map(c=>({
        event:'translation-omitted',version:'4.1.8',route:task.translationMode+'-translation',stage:'translation',source:c,action:'omit-translation-only',terminalState:'omitted'})));
     }
     check();
     const output=await sub.reservePath(dir,base+'.译文.srt');
     await sub.writeAtomicText(output,sub.build(finalTranslation,{allowEmpty:true}));
      const writtenTranslation=await sub.read(output,{allowEmpty:true});
      if(writtenTranslation.length!==finalTranslation.length)throw Error('译文正式文件条数校验失败');
      await this.diagnostic(task.translationDiagnostics,[{event:'translation-output-finalized',version:'4.1.8',route:task.translationMode+'-translation',stage:'translation',
       inputCues:original.length,outputCues:finalTranslation.length,dropped:drops.size,
       terminalState:drops.size?'completed-with-omissions':'completed',outputFile:output}]);
     task.translation=output;
     task.translationCleanup={originalCount:original.length,cleanedCount:finalTranslation.length,
      removedCount:drops.size,omittedCount:drops.size,synchronizedDrops:0,renumbered:true,sourceUntouched:true};
     task.language=task.translationMode==='local'?'中文':settings.language;
     task.recognizedOnly=false;task.done=true;task.status='已完成';task.qualityPending=false;
     task.warning='';task.forcePending=false;task.forceGeneration='';task.translationRedoPending=false;
     await saveCompletion(task,true);
     await this.persist();
     await this.cleanupFiles(cacheFiles);await this.cleanupTaskResume(task);succeeded++;
     await this.log(path.basename(task.path)+' 完成：'+task.translation);
    }catch(error){
     if(error.code==='QUEUE_STOP'){task.status='已暂停';task.error=String(error.message||error);throw error}
     task.done=false;task.status=signal.aborted?'已取消':'失败';
     task.error=[settings.key,settings.recognitionKey].filter(Boolean).reduce((message,key)=>message.split(key).join('[已隐藏]'),String(error.message||error));
     if(signal.aborted)cancelledCount++;else failed++;
     await this.log(path.basename(task.path)+' '+task.status+'：'+task.error);
    }finally{
     if(temporarySource)await fs.rm(temporarySource,{force:true}).catch(()=>{});
    }
    await this.persist();this.notify();
    if(signal.aborted)break;
   }
  }catch(error){
   if(error.code==='QUEUE_STOP')queueStopReason=String(error.message||error);
   else if(!signal.aborted){admissionError=String(error.message||error);throw error}
  }finally{
   try{if(recognizer)await recognizer.close()}catch(error){await this.log('识别资源释放：'+error.message)}
   try{await localServer?.close()}catch(error){await this.log('翻译资源释放：'+error.message)}
   this.running=false;this.controller=null;
   await this.persist();
   const cancelled=signal.aborted,paused=!!queueStopReason,notStarted=Math.max(0,queue.length-attempted);
   const pausedCount=paused&&attempted>succeeded+failed+cancelledCount?1:0;
   const elapsedMs=Date.now()-started;
   const summary=admissionError?'本轮未启动：'+admissionError:paused?'本轮已暂停：'+queueStopReason+'；完成 '+succeeded+' 项，失败 '+failed+' 项，暂停 '+pausedCount+' 项，未执行 '+notStarted+' 项':
    cancelled?'本轮已取消，完成 '+succeeded+' 项，失败 '+failed+' 项，未执行 '+notStarted+' 项':
    '本轮完成 '+succeeded+' 项，失败 '+failed+' 项';
   this.notify({summary:summary+'，耗时 '+formatDuration(elapsedMs/60000),overall:cancelled||paused?undefined:admitted?100:undefined});
   if(admitted||queueStopReason){
    const terminal={event:'queue-finished',summary:summary+'，耗时 '+formatDuration(elapsedMs/60000),
     succeeded,failed,cancelled,paused,cancelledCount,pausedCount,
     notStarted,reason:queueStopReason,elapsedMs};
    await sub.atomic(path.join(this.dataDir,'queue-summary.json'),terminal).catch(error=>this.log('队列摘要保存失败：'+error.message));
    this.emit(terminal);
   }
  }
  const result={succeeded,failed};
  Object.defineProperties(result,{interrupted:{value:queueStopReason||null},cancelled:{value:signal.aborted},
   notStarted:{value:Math.max(0,queue.length-attempted)}});
  return result;
 }
}
module.exports={Pipeline,formatDuration,formatBytes};







