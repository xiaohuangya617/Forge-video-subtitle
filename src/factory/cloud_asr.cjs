const fs=require('node:fs/promises');
const nativeFs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const sub=require('./subtitles.cjs');

const redact=(value,key='')=>String(value||'').split(String(key||'')).join(key?'[Key 已隐藏]':'').replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [已隐藏]');
const stamp=ms=>{ms=Math.max(0,Math.round(Number(ms)||0));const h=Math.floor(ms/3600000);ms%=3600000;const m=Math.floor(ms/60000);ms%=60000;const s=Math.floor(ms/1000);return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`};
const sleep=async(ms,signal)=>{await delay(ms,null,signal?{signal}:{})};
function endpoint(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash)throw Error('识别 Base URL 必须是有效的 HTTP/HTTPS 地址');return u.href.replace(/\/$/,'')}
function abortError(){return Error('任务已取消；已提交的云端识别任务已保留，可再次点击开始继续查询')}
async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),'utf8');await fs.rename(tmp,file)}
function retryable(status,submit){return submit?status===429:!status||status===408||status===429||status>=500}
class CloudRecognizer{
 constructor(resources,appDir,dataDir,onEvent,signal){Object.assign(this,{resources,appDir,dataDir,onEvent,signal});this.dead=false;this.abort=()=>{this.cancelled=true};signal?.addEventListener('abort',this.abort,{once:true})}
 async request(url,options,settings,{submit=false}={}){
  const base=endpoint(url);let attempt=0;
  for(;;){
   const timer=new AbortController();const timeout=setTimeout(()=>timer.abort(),Math.max(1000,Number(settings.recognitionTimeout)||120000));
   try{
    const signal=this.signal?AbortSignal.any([this.signal,timer.signal]):timer.signal;
    const response=await fetch(base,{...options,redirect:'error',signal});const text=await response.text();let data={};try{data=text?JSON.parse(text):{}}catch{throw Error('阿里云返回的不是 JSON')}
    if(!response.ok){const e=Error(redact(`阿里云识别请求失败（HTTP ${response.status}）：${data.message||data.code||text.slice(0,300)}`,settings.recognitionKey));e.status=response.status;throw e}
    return data;
   }catch(e){if(this.signal?.aborted||this.cancelled)throw abortError();if(timer.signal.aborted){e=Error('阿里云识别请求超时');e.status=408}if(!retryable(e.status,submit)||attempt>=Number(settings.recognitionRetries||0))throw e;attempt++;this.onEvent({event:'recognition-retry',message:`阿里云请求失败，准备重试（${attempt}/${settings.recognitionRetries}）`});await sleep(Math.min(30000,1500*2**(attempt-1)),this.signal)}finally{clearTimeout(timeout)}
  }
 }
 async pythonAudio(media,target,{timeoutMs=600000,onEvent=()=>{},spawnFn=spawn}={}){
  this.signal?.throwIfAborted();
  await new Promise((resolve,reject)=>{
   const child=spawnFn(path.join(this.resources,'runtime','python.exe'),[path.join(this.appDir,'cloud_audio.py'),
    '--source',media,'--target',target],{windowsHide:true,env:{...process.env,
     PYTHONPATH:path.join(this.resources,'runtime','vendor'),PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}});
   this.audioChild=child;
   let stderr='',terminalError=null,settled=false;
   const finish=error=>{
    if(settled)return;settled=true;
    clearTimeout(timer);this.signal?.removeEventListener('abort',abort);this.audioChild=null;
    error?reject(error):resolve();
   };
   const stop=error=>{
    if(terminalError)return;terminalError=error;
    require('./recognition.cjs').killTree(child).catch(()=>{try{child.kill()}catch{}});
   };
   const abort=()=>stop(abortError());
   const timer=setTimeout(()=>{
    onEvent({event:'recognition-audio-timeout',timeoutMs});
    stop(Object.assign(Error('云端识别音频提取超时（'+Math.ceil(timeoutMs/1000)+' 秒）'),{code:'AUDIO_TIMEOUT'}));
   },Math.max(1,Number(timeoutMs)||600000));
   this.signal?.addEventListener('abort',abort,{once:true});
   if(this.signal?.aborted)abort();
   child.stderr.on('data',buffer=>{stderr=(stderr+buffer.toString()).slice(-2000)});
   child.once('error',error=>finish(terminalError||error));
   child.once('close',code=>finish(terminalError||(code===0?null:Error(stderr||'音频提取失败（'+code+'）'))));
  });
 }
 async run(job){
  const s=job.recognitionSettings||{};if(s.recognitionMode!=='cloud')throw Error('识别模式不是云端接口');const base=endpoint(s.recognitionBaseurl||'https://dashscope.aliyuncs.com/api/v1');if(!s.recognitionKey?.trim())throw Error('请填写识别 API Key');if(!s.recognitionModel?.trim())throw Error('识别模型名称不能为空');
  const stateFile=job.cloud_state_file,resultFile=job.cloud_result_file;let state={};try{state=JSON.parse(await fs.readFile(stateFile,'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('阿里云识别状态文件损坏，请删除产物目录中的 .aliyun-task.json 后重试')}
  if(state.status==='SUBMITTING'&&!state.taskId)throw Error('上次提交结果未确认，任务 ID 尚未记录；请到阿里云控制台确认后再继续，避免重复计费')
  if(state.terminalConfirmed&&['FAILED','CANCELED'].includes(state.status)){
   await sub.appendJsonl(job.diagnostic_output,[{event:'cloud-failed-task-rebuild',taskId:state.taskId,status:state.status,message:state.failureReason||'',time:new Date().toISOString()}]).catch(()=>{});
   this.onEvent({event:'info',message:'已确认旧识别任务失败，本项将重新提交，可能产生新的云端费用'});
   state={previousFailures:[...(state.previousFailures||[]),{taskId:state.taskId,status:state.status,message:state.failureReason||''}]};
   await atomic(stateFile,state);
  }
  const headers={Authorization:`Bearer ${s.recognitionKey}`,'Content-Type':'application/json'};const save=()=>atomic(stateFile,state);const emit=(m)=>this.onEvent({...m,stage:'recognition-cloud'});const diag=entry=>sub.appendJsonl(job.diagnostic_output,[{time:new Date().toISOString(),...entry}]).catch(()=>{});
  if(!state.taskId){const audio=path.join(path.dirname(stateFile),`.cloud-audio-${crypto.randomUUID()}.wav`);try{emit({event:'info',message:'正在提取云端识别音频'});const audioStarted=Date.now();await diag({event:'cloud-audio-start',stage:'audio-extraction',timeoutMs:600000});try{await this.pythonAudio(job.media,audio,{onEvent:emit});const audioStat=await fs.stat(audio);if(!audioStat.isFile()||audioStat.size<128)throw Error('云端音频提取输出为空或无效');await diag({event:'cloud-audio-complete',stage:'audio-extraction',elapsedMs:Date.now()-audioStarted,size:audioStat.size})}catch(error){await diag({event:'cloud-audio-failed',stage:'audio-extraction',elapsedMs:Date.now()-audioStarted,code:error.code||'',message:redact(error.message,s.recognitionKey)});throw error}const size=(await fs.stat(audio)).size;const policy=await this.request(`${base}/uploads?action=getPolicy&model=${encodeURIComponent(s.recognitionModel)}`,{headers},s);const p=policy.data;if(!p?.policy||!p.signature||!p.upload_dir||!p.upload_host||!p.oss_access_key_id)throw Error('阿里云上传凭证不完整，请检查模型权限和 Base URL');const object=p.upload_dir.replace(/\/$/,'')+'/'+crypto.randomUUID()+'.wav';const form=new FormData();for(const [k,v] of Object.entries({OSSAccessKeyId:p.oss_access_key_id,policy:p.policy,Signature:p.signature,key:object,'x-oss-object-acl':p.x_oss_object_acl||'private','x-oss-forbid-overwrite':p.x_oss_forbid_overwrite||'true',success_action_status:'200'}))form.set(k,String(v));const blob=nativeFs.openAsBlob?await nativeFs.openAsBlob(audio,{type:'audio/wav'}):new Blob([await fs.readFile(audio)],{type:'audio/wav'});form.set('file',blob,'audio.wav');emit({event:'info',message:`正在上传音频 · ${(size/1024/1024).toFixed(1)} MB`});await this.request(p.upload_host,{method:'POST',body:form},s);state={status:'SUBMITTING'};await save();const payload={model:s.recognitionModel,input:{file_urls:['oss://'+object]},parameters:{channel_id:[0],language_hints:['ja']}};if(s.recognitionPrompt)payload.input.context=[{role:'user',content:[{type:'input_text',text:s.recognitionPrompt}]}];emit({event:'info',message:'正在提交阿里云识别任务'});await diag({event:'cloud-submit-start',model:s.recognitionModel});let submitted;try{submitted=await this.request(`${base}/services/audio/asr/transcription`,{method:'POST',headers:{...headers,'X-DashScope-Async':'enable','X-DashScope-OssResourceResolve':'enable'},body:JSON.stringify(payload)},s,{submit:true})}catch(e){if(e.status===408||!e.status||e.status>=500){throw Error(`${e.message}；提交结果未确认，已保留状态文件，请勿盲目重复提交`)}if(e.status>=400&&e.status<500){await diag({event:'cloud-submit-failed',status:e.status,message:e.message});await fs.unlink(stateFile).catch(()=>{});}throw e}if(!submitted.output?.task_id)throw Error('阿里云没有返回任务 ID，已保留状态文件，请到控制台确认后再操作');state={...state,taskId:submitted.output.task_id,status:submitted.output.task_status||'PENDING'};await save();await diag({event:'cloud-submit-complete',taskId:state.taskId,status:state.status})}finally{await fs.unlink(audio).catch(()=>{})}}
  emit({event:'heartbeat',message:`阿里云识别任务 ${state.taskId} 已记录`});const deadline=Date.now()+6*60*60*1000;let polls=0;while(true){if(this.signal?.aborted||this.cancelled)throw abortError();if(Date.now()>deadline)throw Error('阿里云识别等待超时；任务 ID 已保存，再次点击开始会继续查询');const status=await this.request(`${base}/tasks/${encodeURIComponent(state.taskId)}`,{headers},s);const out=status.output||{};polls++;if(out.task_status==='SUCCEEDED'){const result=out.results?.[0];if(!result?.transcription_url)throw Error(redact(`阿里云未返回识别结果地址：${result?.message||'未知错误'}`,s.recognitionKey));const raw=await this.request(result.transcription_url,{},s);await atomic(resultFile,raw);if(!Array.isArray(raw.transcripts))throw Error('阿里云识别结果缺少字幕结构');const cues=[];for(const tr of raw.transcripts||[])for(const row of tr.sentences||[]){const text=String(row.text||'').replace(/\s+/g,' ').trim();const a=Number(row.begin_time),b=Number(row.end_time);if(text&&Number.isFinite(a)&&Number.isFinite(b)&&b>a)cues.push({id:cues.length+1,time:`${stamp(a)} --> ${stamp(b)}`,text})}await fs.writeFile(job.output,sub.build(cues,{allowEmpty:true}),'utf8');await diag({event:'recognition-cloud-complete',taskId:state.taskId,polls,cueCount:cues.length,model:s.recognitionModel});state.status='SUCCEEDED';await save();return {timing:{wall_seconds:0,stages:{cloud_polls:polls}},reviewCount:0}}
   if(['FAILED','UNKNOWN','CANCELED'].includes(out.task_status)){state.status=out.task_status;state.terminalConfirmed=['FAILED','CANCELED'].includes(out.task_status);state.failureReason=out.message||status.message||'请检查权限和额度';await save();await diag({event:'cloud-poll-failed',taskId:state.taskId,status:out.task_status,message:state.failureReason});throw Error(redact(`阿里云识别${out.task_status}：${state.failureReason}`,s.recognitionKey))}
   state.status=out.task_status||'PENDING';await save();emit({event:'progress',message:`阿里云识别中 · 已查询 ${polls} 次`});await sleep(5000,this.signal)
  }
 }
 async close(){this.signal?.removeEventListener('abort',this.abort);this.cancelled=true}
}
module.exports={CloudRecognizer};
