const $=id=>document.getElementById(id),api=window.desktop;
let tasks=[],cues=[],busy=false,adding=false,dirty=false,loadedName='',loadedLanguage='中文',focusedIndex=-1,ready=false,editorBusy=false,closing=false,editRevision=0;
let preparingStart=false,startIntent=0,editorWork=Promise.resolve(),draftTimer,draftWrite=Promise.resolve();
const localModelLabel='Hy-MT2（内置模型，结束释放）';
let flagPreferences={flagJa:true,flagEn:true};
let repeatFlag=false,onlyFlag=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const name=p=>String(p).split(/[\\/]/).pop();
function toast(s){$('toast').textContent=s;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6500)}
function switchTab(edit){$('generate').hidden=edit;$('edit').hidden=!edit;$('settingsActions').hidden=edit;for(const [id,on]of [['tabGenerate',!edit],['tabEdit',edit]]){$(id).classList.toggle('active',on);$(id).setAttribute('aria-selected',String(on))}}
$('tabGenerate').onclick=()=>switchTab(false);$('tabEdit').onclick=()=>switchTab(true);
const settingIds=['recognitionEnabled','recognitionMode','recognitionKey','recognitionModel','recognitionBaseurl','recognitionTimeout','recognitionRetries','recognitionPrompt','cpuMode','trayOnClose','translationEnabled','translationMode','localBaseurl','key','model','baseurl','language','timeout','tokens','retries','prompt','genDir'];
function refresh(){
 const locked=busy||preparingStart||adding||closing||!ready;
 for(const id of [...settingIds,'add','addFolder','clear','pickGen','saveSettings','importSettings','exportSettings','clearCache'])if($(id))$(id).disabled=locked;
 const recognitionCloud=$('recognitionMode').value==='cloud';
 $('recognitionModeLocal').disabled=locked;$('recognitionModeCloud').disabled=locked;
 $('recognitionModeLocal').classList.toggle('active',!recognitionCloud);$('recognitionModeCloud').classList.toggle('active',recognitionCloud);
 $('recognitionLocal').hidden=recognitionCloud;$('recognitionCloud').hidden=!recognitionCloud;
 for(const id of ['recognitionKey','recognitionModel','recognitionBaseurl','recognitionTimeout','recognitionRetries','recognitionPrompt'])if($(id))$(id).disabled=locked||!recognitionCloud;
 const local=$('translationMode').value==='local',key=$('key'),keyField=$('keyField');
 if(local){$('language').value='中文';key.value=localModelLabel;key.type='text';key.readOnly=true;key.title='内置模型，任务结束后释放';keyField.childNodes[0].nodeValue='本机模型'}
 else{key.value=key.dataset.cloudValue??'';key.dataset.cloudValue=key.value;key.type='password';key.readOnly=false;key.title='';keyField.childNodes[0].nodeValue='API Key'}
 for(const id of ['model','baseurl','language','timeout','tokens','retries','prompt'])$(id).disabled=locked||local;
 key.disabled=local?false:locked||!$('translationEnabled').checked;$('localBaseurl').disabled=true;
 $('modeLocal').disabled=locked;$('modeCloud').disabled=locked;$('modeLocal').classList.toggle('active',local);$('modeCloud').classList.toggle('active',!local);$('translationLocal').hidden=!local;$('translationCloud').hidden=local;$('translationToggle').disabled=locked;$('translationToggle').classList.toggle('active',Boolean($('translationEnabled').checked));$('translationToggle').setAttribute('aria-pressed',String(Boolean($('translationEnabled').checked)));
 $('start').textContent=$('translationEnabled').checked?'▶ 开始执行':($('recognitionMode').value==='cloud'?'▶ 开始云端识别':'▶ 开始本地识别');
 $('start').disabled=locked||!tasks.length;$('forceStart').disabled=locked||!tasks.length;$('cancel').disabled=!busy||closing;
 for(const id of ['importPair','loadTask','export','editTask','pickEdit','find','replace','findNext','replaceOne','replaceAll','repeatFlag','onlyFlag','rules'])$(id).disabled=editorBusy||closing||!ready||(id==='export'&&!cues.length);
 for(const el of $('cues').querySelectorAll('textarea'))el.disabled=editorBusy||closing;
 for(const [id,language]of [['flagJa','日语'],['flagEn','英语']]){const suspended=cues.length>0&&loadedLanguage===language;$(id).checked=flagPreferences[id];$(id).disabled=editorBusy||closing||!ready||suspended;$(id).parentElement.title=suspended?'当前译文为'+language+'，暂不检测该语言残留':''}
}
function taskDisplayStatus(t){const status=String(t.status||'').split(' · ')[0];if(status==='已完成（含待复核）')return '已完成，含待复核，详见诊断';return status}
function parentName(p){const bits=String(p||'').split(/[\\/]/).filter(Boolean);return bits.length>1?bits[bits.length-2]:''}
function renderTasks(){const selected=$('editTask').value;$('count').textContent=tasks.length;$('tasks').innerHTML=tasks.length?tasks.map((t,i)=>`<div class="task"><span class="task-num">${String(i+1).padStart(2,'0')}</span><div class="task-copy"><b title="${esc(t.path)}">${esc(name(t.path))}</b><small class="${t.error?'task-error':''}" title="${esc(t.error||t.translation||t.source||'')}">${esc(taskDisplayStatus(t))}${t.error?' · '+esc(t.error):''}</small></div><div class="task-actions"><button title="上移" data-i="${i}" data-action="up" ${busy||adding||closing||i===0?'disabled':''}>↑</button><button title="下移" data-i="${i}" data-action="down" ${busy||adding||closing||i===tasks.length-1?'disabled':''}>↓</button><button title="移除" data-i="${i}" data-action="remove" ${busy||adding||closing?'disabled':''}>×</button></div></div>`).join(''):'<div class="empty">拖入视频，或点击上方添加文件<br><small>按列表顺序生成字幕；翻译可选</small></div>';$('queueSummary').textContent=`共 ${tasks.length} 项 · 已完成 ${tasks.filter(t=>t.done&&!t.recognizedOnly).length} 项 · 待翻译 ${tasks.filter(t=>t.recognizedOnly).length} 项`;const editable=tasks.filter(t=>t.done&&t.translation),counts=new Map();for(const t of editable){const label=name(t.path);counts.set(label,(counts.get(label)||0)+1)}$('editTask').innerHTML='<option value="">选择已生成任务</option>'+editable.map(t=>{const label=name(t.path),suffix=counts.get(label)>1?` · ${parentName(t.path)}`:'';return `<option value="${esc(t.id)}">${esc(label+suffix)}</option>`}).join('');$('editTask').value=selected;refresh()}
$('tasks').onclick=async e=>{const b=e.target.closest('button');if(!b||busy||adding||closing)return;const t=tasks[Number(b.dataset.i)];if(t)try{await api.change(b.dataset.action,t.id)}catch(e){toast(e.message)}};
$('clear').onclick=async()=>{if(tasks.length&&confirm('移除任务列表？已生成文件会保留。'))try{await api.change('clear')}catch(e){toast(e.message)}};
async function add(paths){if(!paths.length||busy||adding||closing)return;adding=true;refresh();$('status').textContent='正在检查视频与音频…';try{const errors=await api.add(paths);$('status').textContent=errors.length?`已添加可用视频；${errors.length} 项未通过检查`:'视频已就绪';if(errors.length)toast(errors.join('\n'))}catch(e){toast(e.message)}finally{adding=false;renderTasks()}}
$('add').onclick=async()=>{try{await add(await api.files())}catch(e){toast(e.message)}};$('addFolder').onclick=async()=>{try{const folder=await api.folder();if(folder)await add([folder])}catch(e){toast(e.message)}};
const isVideoName=value=>/\.(mp4|mkv|mov|avi|webm)$/i.test(String(value||''));
async function readDropEntry(entry){
 if(!entry)return [];
 if(entry.isFile){if(!isVideoName(entry.name))return [];return new Promise((resolve,reject)=>entry.file(file=>resolve([file]),reject))}
 if(!entry.isDirectory||typeof entry.createReader!=='function')return [];
 const reader=entry.createReader(),entries=[];
 while(true){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;entries.push(...batch)}
 entries.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'zh-CN'));
 const files=[];for(const child of entries)files.push(...await readDropEntry(child));return files;
}
async function droppedPaths(dataTransfer){
 const items=Array.from(dataTransfer?.items||[]);
 const entries=items.map(item=>item?.webkitGetAsEntry?.()).filter(Boolean);
 if(entries.length){const files=[];for(const entry of entries)files.push(...await readDropEntry(entry));return [...new Set(files.map(file=>api.path(file)).filter(Boolean))]}
 return [...new Set(Array.from(dataTransfer?.files||[]).filter(file=>isVideoName(file?.name)).map(file=>api.path(file)).filter(Boolean))];
}
const taskZone=$('taskZone');taskZone.ondragover=e=>{e.preventDefault();if(!busy)taskZone.classList.add('over')};taskZone.ondragleave=e=>{if(!e.relatedTarget||!taskZone.contains(e.relatedTarget))taskZone.classList.remove('over')};taskZone.ondrop=async e=>{e.preventDefault();taskZone.classList.remove('over');try{await add(await droppedPaths(e.dataTransfer))}catch(error){toast('读取拖拽内容失败：'+error.message)}};document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());
let uiTimer,uiWrite=Promise.resolve(),rememberedPromptHeight=48;
function promptHeight(){const height=Math.round($('prompt').getBoundingClientRect().height);if(height>=44)rememberedPromptHeight=Math.min(600,height);return rememberedPromptHeight}
function uiSnapshot(){return {editDir:$('editDir').value,rules:$('rules').value,promptHeight:promptHeight(),...flagPreferences}}
function flushUI(){clearTimeout(uiTimer);const data=uiSnapshot();uiWrite=uiWrite.catch(()=>{}).then(()=>api.saveUI(data));return uiWrite}
function saveUI(){clearTimeout(uiTimer);uiTimer=setTimeout(()=>flushUI().catch(e=>toast('规则保存失败：'+e.message)),250)}
function flushDraft(){
 clearTimeout(draftTimer);
 const data=dirty?{cues:cues.map(c=>({id:c.id,time:c.time,text:c.text}))}:null;
 draftWrite=draftWrite.catch(()=>{}).then(()=>api.saveDraft(data));
 return draftWrite;
}
function saveDraft(){clearTimeout(draftTimer);draftTimer=setTimeout(()=>flushDraft().catch(e=>toast('草稿保存失败：'+e.message)),250)}
api.onPrepareClose(async()=>{
 closing=true;startIntent++;refresh();
 try{await editorWork.catch(()=>{});await flushDraft();await flushUI();if(!await api.finishClose(true)){closing=false;refresh()}}
 catch(e){closing=false;refresh();toast('退出前保存失败：'+e.message);await api.finishClose(false,e.message)}
});
for(const [b,f]of [['pickGen','genDir'],['pickEdit','editDir']])$(b).onclick=async()=>{try{const p=await api.folder();if(p){$(f).value=p;if(f==='editDir')saveUI();else $('settingsStatus').textContent='设置已修改，请保存'}}catch(e){toast(e.message)}};
for(const [b,f]of [['openGen','genDir'],['openEdit','editDir']])$(b).onclick=async()=>{const p=$(f).value||(f==='genDir'&&tasks[0]?.path.replace(/[\\/][^\\/]+$/,''));try{if(p)await api.open(p);else toast('尚未确定输出目录')}catch(e){toast(e.message)}};
$('viewLog').onclick=()=>api.log().catch(e=>toast(e.message));$('clearCache').onclick=async()=>{if(confirm('清除翻译缓存？已有字幕不会删除，后续翻译会重新请求接口。'))try{await api.clearCache();toast('缓存已清除')}catch(e){toast(e.message)}};
function collectSettings(){const local=$('translationMode').value==='local';return Object.fromEntries(settingIds.map(id=>[id,$(id).type==='checkbox'?$(id).checked:id==='key'&&local?($('key').dataset.cloudValue||''):id==='timeout'||id==='recognitionTimeout'?($('translationEnabled').checked||id==='recognitionTimeout'?FactoryUnits.toMilliseconds($(id).value):120000):$(id).value]))}
function applySettings(data){for(const id of settingIds)if($(id)&&id in data){if($(id).type==='checkbox')$(id).checked=data[id];else $(id).value=(id==='timeout'||id==='recognitionTimeout')?Number(data[id])/1000:data[id]}$('key').dataset.cloudValue=$('key').value;$('recognitionKey').dataset.cloudValue=$('recognitionKey').value;refresh()}
for(const id of settingIds)$(id).addEventListener('input',()=>$('settingsStatus').textContent='设置已修改，请保存');
$('key').addEventListener('input',()=>{if($('translationMode').value==='cloud')$('key').dataset.cloudValue=$('key').value});$('recognitionKey').addEventListener('input',()=>{$('recognitionKey').dataset.cloudValue=$('recognitionKey').value});
$('translationEnabled').onchange=()=>refresh();$('translationToggle').onclick=()=>{if(busy||adding||closing||!ready)return;$('translationEnabled').checked=!$('translationEnabled').checked;refresh();$('settingsStatus').textContent=$('translationEnabled').checked?'设置已修改：翻译已启用':'设置已修改：翻译已关闭'};
function setRecognitionMode(mode){$('recognitionMode').value=mode;refresh();$('settingsStatus').textContent='设置已修改，请保存'}
$('recognitionModeLocal').onclick=()=>setRecognitionMode('local');$('recognitionModeCloud').onclick=()=>setRecognitionMode('cloud');
function setTranslationMode(mode){$('translationMode').value=mode;if(mode==='local')$('language').value='中文';refresh();$('settingsStatus').textContent='设置已修改，请保存'}
$('modeLocal').onclick=()=>setTranslationMode('local');$('modeCloud').onclick=()=>setTranslationMode('cloud');
$('saveSettings').onclick=async()=>{try{await api.saveSettings(collectSettings());$('settingsStatus').textContent='设置已保存';toast('下次启动会恢复这些设置')}catch(e){toast('保存失败：'+e.message)}};
$('exportSettings').onclick=async()=>{try{if(await api.exportSettings(collectSettings()))toast('已导出设置，不包含 API Key')}catch(e){toast(e.message)}};
$('importSettings').onclick=async()=>{try{const data=await api.importSettings(collectSettings());if(data){applySettings(data);$('settingsStatus').textContent='设置已导入并保存';toast('设置已导入，保留当前 API Key')}}catch(e){toast('导入失败：'+e.message)}};
async function runStart(force=false){if(busy||closing||!ready)return;if(force&&!confirm('将忽略已有字幕，重新识别并翻译当前任务列表。确定继续吗？'))return;busy=true;refresh();$('progress').value=0;$('percent').textContent='0%';$('status').textContent=force?'正在强制重新执行…':'正在检查已有字幕…';try{await api.start(collectSettings(),force);$('settingsStatus').textContent='设置已保存'}catch(e){toast(e.message);$('status').textContent=e.message}finally{busy=false;refresh()}}
$('start').onclick=()=>runStart(false);$('forceStart').onclick=()=>runStart(true);
$('cancel').onclick=async()=>{startIntent++;await api.cancel();$('status').textContent='正在取消，保留已生成文件…'};
api.onProgress(m=>{if(m.event==='state'){tasks=m.tasks;busy=m.running;renderTasks();if(m.summary)$('status').textContent=m.summary}else if(m.event==='persistence-warning'){const text=m.message||'任务状态保存出现问题';$('status').textContent=text;toast(text)}else if(m.event==='persistence-recovered'){$('status').textContent=m.message||'任务状态保存已恢复'}else if(m.event==='disk-warning'){$('status').textContent=m.message||'磁盘空间偏低，请及时清理'}else if(m.event==='local-server'){const text={checking:'正在检查本地翻译服务…',reused:'已复用本地翻译服务',starting:'正在启动 Hy-MT2 本地服务…',ready:'Hy-MT2 本地服务已就绪',recovering:'本地翻译服务中断，正在自动恢复…',recovered:'Hy-MT2 本地服务已恢复'}[m.status]||'正在准备本地翻译服务…';$('status').textContent=text}else{const prefix=`${m.queueIndex}/${m.queueTotal} · ${m.name} · `;const labels={'checkpoint-resume':`恢复识别进度 ${m.current||0}/${m.total||0} 段`,'coverage-progress':`完整识别 ${m.current||0}/${m.total||0} 段`,loading:'加载本机模型…',loaded:'模型已加载',heartbeat:'识别处理中…',info:'正在识别原声',progress:'正在识别原声', 'recognition-retry':'可疑片段补识别中…',done:'原声字幕已保存','source-cleanup':`原声重复清理 ${m.removed||0} 条`,'translation-cleanup':`译文重复收束 ${m.removed||0} 条`};if(m.event==='translation')$('status').textContent=prefix+(m.cached?'读取翻译缓存':`翻译 ${m.batch}/${m.total} 批${m.attempt?' · 尝试 '+m.attempt+'/'+m.maxAttempts:''}`);else if(m.event==='translation-warning')$('status').textContent=prefix+`第 ${m.batch}/${m.total} 条已收束，继续执行`;else if(labels[m.event])$('status').textContent=prefix+labels[m.event]}if(m.overall!=null){$('progress').value=m.overall;$('percent').textContent=m.overall+'%'}});
function hasRepeatedPhrase(text){return /([\u4e00-\u9fff]{3,})(?:[，,、。.!！?？；;：:\s]*\1){1,}/.test(text)}
function reasons(c){const r=[];if(!c.text.trim())r.push('缺少译文，导出时跳过');if(loadedLanguage!=='日语'&&$('flagJa').checked&&/[\u3040-\u30ff]/.test(c.text))r.push('日文残留');if(loadedLanguage!=='英语'&&$('flagEn').checked&&/[A-Za-z]/.test(c.text))r.push('英文残留');for(const w of $('rules').value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean))if(c.text.includes(w))r.push('指定词：'+w);if(repeatFlag&&hasRepeatedPhrase(c.text))r.push('重复片段');return r}
function updateFlags(){let n=0;for(let i=0;i<cues.length;i++){const r=reasons(cues[i]);if(r.length)n++;const row=$('cues').querySelector(`[data-cue="${i}"]`);if(row){row.classList.toggle('flag',!!r.length);row.querySelector('.reason').textContent=r.join(' · ');row.hidden=onlyFlag&&!r.length}}$('flagCount').textContent=`${cues.length} 条 · ${n} 条待检查`;return n}
function renderCues(){if(!cues.length)return;$('cues').innerHTML=cues.map((c,i)=>`<div class="cue" data-cue="${i}"><time><b>${String(c.id).padStart(3,'0')}</b>${esc(c.time.split(' --> ')[0])}<br>${esc(c.time.split(' --> ')[1])}</time><div class="original">${esc(c.original)}</div><div><textarea aria-label="第 ${i+1} 条译文" data-index="${i}">${esc(c.text)}</textarea><div class="reason"></div></div></div>`).join('');updateFlags();refresh()}
async function load(get){
 if(editorBusy||closing)return;if(dirty&&!confirm('当前有未导出修改，是否重新加载？'))return;
 editorBusy=true;refresh();clearTimeout(draftTimer);
 editorWork=(async()=>{
  await draftWrite.catch(()=>{});const result=await get();if(!result)return;
  cues=result.cues;loadedName=result.name;loadedLanguage=result.language||$('language').value;dirty=false;
  editRevision++;focusedIndex=-1;renderCues();$('validation').textContent=`已加载 ${cues.length} 条 · ${loadedName}`;
  await flushDraft();saveUI();
 })();
 try{await editorWork}catch(e){toast('加载失败：'+e.message)}finally{editorBusy=false;refresh()}
}
$('importPair').onclick=()=>load(()=>api.importPair());$('loadTask').onclick=()=>{if(!$('editTask').value)return toast('请选择已完成任务');load(()=>api.loadTask($('editTask').value))};
$('cues').oninput=e=>{if(!editorBusy&&!closing&&e.target.matches('textarea')){editRevision++;cues[Number(e.target.dataset.index)].text=e.target.value;dirty=true;$('validation').textContent='有未导出修改';updateFlags();saveDraft()}};$('cues').onfocusin=e=>{if(e.target.matches('textarea'))focusedIndex=Number(e.target.dataset.index)};
for(const id of ['flagJa','flagEn','rules'])$(id).oninput=()=>{if(editorBusy||closing)return;if(id==='flagJa'||id==='flagEn')flagPreferences[id]=$(id).checked;updateFlags();saveUI()};
function setFlagButton(button,on){$(button).classList.toggle('active',on);$(button).setAttribute('aria-pressed',String(on))}
$('repeatFlag').onclick=()=>{if(editorBusy||closing)return;repeatFlag=!repeatFlag;setFlagButton('repeatFlag',repeatFlag);updateFlags()};
$('onlyFlag').onclick=()=>{if(editorBusy||closing)return;onlyFlag=!onlyFlag;setFlagButton('onlyFlag',onlyFlag);updateFlags()};
if(window.ResizeObserver){new ResizeObserver(()=>{if(ready&&!closing&&$('prompt').getBoundingClientRect().height>=44)saveUI()}).observe($('prompt'))}
function findNext(){const q=$('find').value;if(!q)return toast('请输入查找内容');for(let n=1;n<=cues.length;n++){const i=(focusedIndex+n)%cues.length;if(cues[i].text.includes(q)){focusedIndex=i;onlyFlag=false;setFlagButton('onlyFlag',false);updateFlags();const el=$('cues').querySelector(`[data-index="${i}"]`);el.focus();const at=cues[i].text.indexOf(q);el.setSelectionRange(at,at+q.length);el.scrollIntoView({block:'nearest'});return i}}toast('未找到匹配内容');return -1}
$('findNext').onclick=findNext;
function replace(all){if(editorBusy||closing)return;const q=$('find').value;if(!q)return toast('请输入查找内容');let n=0;if(all){for(const c of cues){n+=c.text.split(q).length-1;c.text=c.text.split(q).join($('replace').value)}}else{let i=focusedIndex;if(i<0||!cues[i]?.text.includes(q))i=findNext();if(i>=0){cues[i].text=cues[i].text.replace(q,()=>$('replace').value);n=1}}if(n){editRevision++;dirty=true;renderCues();$('validation').textContent='有未导出修改';saveDraft()}toast(`已替换 ${n} 处`)}$('replaceOne').onclick=()=>replace(false);$('replaceAll').onclick=()=>replace(true);
$('export').onclick=async()=>{
 if(editorBusy||closing)return;if(!cues.length)return toast('请先加载字幕');if(!$('editDir').value)return toast('请选择独立的成品输出目录');
 editorBusy=true;const revision=editRevision;refresh();
 editorWork=(async()=>{
  const result=await api.export({dir:$('editDir').value,name:loadedName,cues:cues.map(c=>({id:c.id,time:c.time,text:c.text}))});
  dirty=editRevision!==revision;const warnings=updateFlags();
  $('validation').textContent=`验证通过 · ${result.count} 条${result.omitted?' · 跳过 '+result.omitted+' 条空译文':''} · ${warnings} 条质量提醒`;
  await flushDraft();toast('已保存：'+result.file);
 })();
 try{await editorWork}catch(e){$('validation').textContent='验证/导出失败：'+e.message;toast(e.message)}finally{editorBusy=false;refresh()}
};
window.addEventListener('beforeunload',e=>{if(!closing&&(dirty||busy||adding||editorBusy)){e.preventDefault();e.returnValue=false}});
(async()=>{refresh();try{const state=await api.state();tasks=state.tasks;busy=state.running;const ui=state.ui||{};$('editDir').value=ui.editDir||'';$('rules').value=ui.rules||'';if(Number.isFinite(Number(ui.promptHeight))&&Number(ui.promptHeight)>=44){rememberedPromptHeight=Math.min(600,Math.round(Number(ui.promptHeight)));$('prompt').style.height=rememberedPromptHeight+'px'}if(typeof ui.flagJa==='boolean')flagPreferences.flagJa=ui.flagJa;if(typeof ui.flagEn==='boolean')flagPreferences.flagEn=ui.flagEn;const data=await api.loadSettings();if(data){applySettings(data);$('settingsStatus').textContent='已恢复上次设置'}else $('settingsStatus').textContent='使用默认设置';try{const draft=await api.loadDraft();if(draft){cues=draft.cues;loadedName=draft.name;loadedLanguage=draft.language||'中文';dirty=true;editRevision++;renderCues();switchTab(true);$('validation').textContent=`已恢复未导出修改 · ${loadedName}`}}catch(e){toast(e.message)}}catch(e){toast(e.message);$('settingsStatus').textContent='设置恢复失败'}finally{ready=true;renderTasks();api.startupReady().catch(()=>{})}})();

// 4.1.5 controls are layered after the legacy renderer bindings so older
// persisted task state continues to render through the same code path.
const refreshBase=refresh;
refresh=()=>{refreshBase();const recognitionEnabled=$('recognitionEnabled').checked;$('recognitionToggle').classList.toggle('active',recognitionEnabled);$('recognitionToggle').setAttribute('aria-pressed',String(recognitionEnabled));$('recognitionToggle').textContent=recognitionEnabled?'启用识别':'识别已关闭';$('recognitionToggle').disabled=busy||adding||closing||!ready;$('trayOnClose').checked=Boolean($('trayOnClose').checked)};
const collectSettingsBase=collectSettings;
collectSettings=()=>Object.fromEntries(settingIds.map(id=>[id,$(id).type==='checkbox'?$(id).checked:id==='key'&&$('translationMode').value==='local'?($('key').dataset.cloudValue||''):id==='timeout'||id==='recognitionTimeout'?FactoryUnits.toMilliseconds($(id).value):$(id).value]));
$('recognitionToggle').onclick=()=>{if(busy||adding||closing||!ready)return;$('recognitionEnabled').checked=!$('recognitionEnabled').checked;refresh();$('settingsStatus').textContent=$('recognitionEnabled').checked?'设置已修改：识别已启用':'设置已修改：仅翻译模式'};
$('recognitionEnabled').onchange=()=>refresh();
$('trayOnClose').onchange=async()=>{if(!ready||closing)return;try{await api.saveSettings(collectSettings());$('settingsStatus').textContent=$('trayOnClose').checked?'已启用关闭后缩小至托盘':'已关闭关闭后缩小至托盘'}catch(e){toast('托盘设置保存失败：'+e.message)}};

function estimateDialog(result,force){$('estimateTasks').textContent=String(result.taskCount||0);$('estimateMode').textContent=`${result.recognitionEnabled?'识别 + ':''}${result.translationEnabled?'翻译':'仅识别'} · ${result.recognitionMode==='cloud'?'云端':'本机'}${result.translationEnabled?` / ${result.translationMode==='cloud'?'云端':'本机'}`:''}`;$('estimateTime').textContent=result.estimatedTimeText||'-';$('estimateSpace').textContent=result.estimatedSpaceText||'-';$('estimateAvailable').textContent=result.availableSpaceText||'-';$('estimateError').hidden=!result.reason;$('estimateError').textContent=result.reason||'';$('estimateConfirm').disabled=!result.spaceEnough||!result.taskCount;$('estimateNote').textContent=result.warning||(force?'强制执行会重新处理已有任务；仅翻译模式仍会复用原声字幕。':'预计值会受电脑性能、音频内容、网络和重试影响。');}
async function runStartEstimated(force=false){
 if(busy||preparingStart||closing||!ready)return;
 if(force&&!confirm('将忽略已有译文，重新执行当前任务。确定继续吗？'))return;
 const intent=++startIntent;
 preparingStart=true;busy=true;refresh();$('status').textContent='正在计算预计耗时和空间…';
 try{
  const data=collectSettings();
  const result=await api.estimate(data,force);
  if(closing||intent!==startIntent)return;
  if(result.allTasks){tasks=result.allTasks;renderTasks()}
  if(!result.taskCount){const message=result.reason||(tasks.length?'任务已完成':'没有待处理任务');$('status').textContent=message;if(result.reason)toast(message);return}
  estimateDialog(result,force);
  const dialog=$('estimateDialog');dialog.returnValue='';dialog.showModal();
  const confirmed=await new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='default'&&!$('estimateConfirm').disabled),{once:true}));
  if(!confirmed||closing||intent!==startIntent)return;
  $('progress').value=0;$('percent').textContent='0%';$('status').textContent=force?'正在强制重新执行…':'正在执行…';
  await api.start(data,force);$('settingsStatus').textContent='设置已保存';
 }catch(error){toast(error.message);$('status').textContent=error.message}
 finally{preparingStart=false;busy=false;refresh()}
}
$('start').onclick=()=>runStartEstimated(false);$('forceStart').onclick=()=>runStartEstimated(true);
api.onProgress(m=>{if(m.event==='queue-finished'){$('status').textContent=m.summary||'本轮任务已结束';busy=false;refresh()}});
refresh();








