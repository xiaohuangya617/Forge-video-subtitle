const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage,Notification,Tray,Menu}=require('electron');const fs=require('node:fs/promises'),path=require('node:path');const {pathToFileURL}=require('node:url');const {setTimeout:delay}=require('node:timers/promises');const sub=require('./subtitles.cjs'),settingsModule=require('./settings.cjs');
app.setName('智能字幕工厂');app.setPath('userData',path.join(app.getPath('appData'),'智能字幕工厂'));let win,splash,pipeline,tray=null,runPromise=null,importPromise=null,editorReference=null,editorSession=null,editorWrites=Promise.resolve(),allowClose=false,closePending=false,closeWork=null,closePreparation=null,startPending=false,startCancelled=false,rendererInitialized=false,rendererReadyResolve,rendererReadyReject,rendererReadyPromise=new Promise((resolve,reject)=>{rendererReadyResolve=resolve;rendererReadyReject=reject});
rendererReadyPromise.catch(()=>{});
const embeddedResources=path.resolve(__dirname,'..');const resources=require('node:fs').existsSync(path.join(embeddedResources,'runtime','python.exe'))?embeddedResources:path.resolve(__dirname,'../release/1.15/智能字幕提取-win32-x64/resources');const dataDir=app.getPath('userData');const iconPath=path.join(__dirname,'assets','smart-subtitle-factory-icon.ico');const store=settingsModule.createStore(path.join(dataDir,'factory-settings.json'),safeStorage);
const drafts=require('./editor_draft.cjs').createDraftStore(path.join(dataDir,'editor-draft.json'));
let splashLoaded=false,splashShown=false,startupFinished=false,startupCancelled=false;
let pendingSplashStage={text:'正在启动程序…',percent:0};
function splashStage(text,percent){
 pendingSplashStage={text,percent:Number(percent)||0};
 if(!splashLoaded||!splash||splash.isDestroyed())return Promise.resolve(false);
 return splash.webContents.executeJavaScript('window.setStartupStage('+JSON.stringify(text)+','+pendingSplashStage.percent+')');
}
async function fade(window,from,to,duration){
 if(!window||window.isDestroyed())return;
 window.setOpacity(from);if(!window.isVisible())window.show();
 const began=Date.now();
 for(;;){
  if(window.isDestroyed())return;
  const t=Math.min(1,(Date.now()-began)/duration),eased=t*t*(3-2*t);
  window.setOpacity(from+(to-from)*eased);
  if(t===1)return;await delay(16);
 }
}
function startupTimeout(promise,timeout,message){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),timeout)})])
  .finally(()=>clearTimeout(timer));
}
function waitForFirstPaint(window){
 const painted=new Promise((resolve,reject)=>{
  const finish=error=>{window.removeListener('ready-to-show',ready);window.removeListener('closed',closed);error?reject(error):resolve()};
  const ready=()=>finish(),closed=()=>finish(Error('启动窗口已关闭'));
  window.once('ready-to-show',ready);window.once('closed',closed);
 });
 const result=startupTimeout(painted,15000,'界面首帧绘制超时');result.catch(()=>{});return result;
}
async function waitForDOMFrame(window){
 await startupTimeout(window.webContents.executeJavaScript(`(async()=>{
  if(document.fonts)await document.fonts.ready;
  await Promise.all([...document.images].map(async image=>{
   await image.decode();if(!image.naturalWidth)throw Error('界面图标加载失败');
  }));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return true;
 })()`),15000,'界面内容绘制超时');
}
function createSplash(){return new BrowserWindow({width:430,height:226,frame:false,resizable:false,show:false,opacity:1,icon:iconPath,backgroundColor:'#081d42',alwaysOnTop:true,autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})}
function mainWindowOptions(){return {width:1060,height:740,minWidth:900,minHeight:620,show:false,opacity:1,icon:iconPath,backgroundColor:'#edf4fc',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}}}
function createTray(){if(tray&&!tray.isDestroyed())return tray;try{tray=new Tray(iconPath);tray.setToolTip('智能字幕工厂');const show=()=>{if(win&&!win.isDestroyed()){win.show();win.restore();win.focus()}};tray.on('click',show);tray.setContextMenu(Menu.buildFromTemplate([{label:'显示主窗口',click:show},{type:'separator'},{label:'退出软件',click:()=>{if(win&&!win.isDestroyed()){win.show();win.focus();closeAppDirect().catch(error=>dialog.showErrorBox('退出失败',error.message))}}}]));return tray}catch(e){pipeline?.log?.(`托盘创建失败：${e.message}`);return null}}
function hideToTray(){if(!createTray())throw Error('无法创建系统托盘，窗口未隐藏');if(win&&!win.isDestroyed()){win.hide();closePending=false}}
let trayPreference=false;
async function prepareRendererClose(){
 if(!rendererInitialized||win.isDestroyed())return;
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{closePreparation=null;reject(Error('退出前保存未响应，窗口已保留，请稍后重试'))},15000);
  closePreparation={finish(error){clearTimeout(timer);closePreparation=null;error?reject(error):resolve()}};
  win.webContents.send('prepare-close');
 });
}
async function closeAppDirect(){
 if(allowClose||!win||win.isDestroyed())return;
 if(closeWork)return closeWork;
 closePending=true;startCancelled=true;pipeline?.cancel();
 closeWork=(async()=>{
  await prepareRendererClose();await Promise.resolve(runPromise).catch(()=>{});
  await Promise.resolve(importPromise).catch(()=>{});await pipeline?.writes;
  if(pipeline?.persistenceFatal)throw Error('任务列表尚未保存，窗口已保留，请检查磁盘后重试');
  await editorWrites.catch(()=>{});await uiWrites;await drafts.flush();await store.flush();
  allowClose=true;startupCancelled=true;startupFinished=true;
  if(splash&&!splash.isDestroyed())splash.destroy();splash=null;
  win.close();
 })().catch(error=>{closePending=false;throw error}).finally(()=>{closeWork=null});
 return closeWork;
}
function wireMainWindow(){win.on('close',e=>{if(allowClose)return;e.preventDefault();if(closePending)return;if(trayPreference){hideToTray();return}closePending=true;startCancelled=true;pipeline?.cancel();closeAppDirect().catch(error=>{closePending=false;dialog.showErrorBox('退出失败',error.message)})});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('will-prevent-unload',e=>{if(allowClose)e.preventDefault()});win.webContents.on('render-process-gone',()=>rendererReadyReject?.(Error('主界面进程已退出')))}
async function startWindows(){
 try{
  splash=createSplash();
  splash.once('closed',()=>{
   splashLoaded=false;
   if(!startupFinished){startupCancelled=true;allowClose=true;if(win&&!win.isDestroyed())win.destroy();app.quit()}
  });
  const splashPaint=waitForFirstPaint(splash);
  await splash.loadFile(path.join(__dirname,'splash.html'));await splashPaint;
  splashLoaded=true;await splashStage(pendingSplashStage.text,pendingSplashStage.percent);
  await waitForDOMFrame(splash);splash.show();splashShown=true;
  await splashStage('正在加载任务记录…',18);
  const {Pipeline}=require('./pipeline.cjs');
  pipeline=new Pipeline({resources,appDir:__dirname,dataDir,emit:m=>{if(win&&!win.isDestroyed())win.webContents.send('factory-progress',m)}});
  await pipeline.init();await splashStage('正在准备工作区…',42);
  if(startupCancelled)return;
  win=new BrowserWindow(mainWindowOptions());wireMainWindow();
  const firstPaint=waitForFirstPaint(win);
  await win.loadFile(path.join(__dirname,'index.html'));await firstPaint;
  await splashStage('正在载入主界面…',78);
  const slowTimer=setTimeout(()=>splashStage('正在恢复任务与设置，请稍候…',78).catch(()=>{}),8000);
  try{await startupTimeout(rendererReadyPromise,120000,'主界面准备超时，请重新启动软件')}
  finally{clearTimeout(slowTimer)}
  await waitForDOMFrame(win);
  if(closeWork)await closeWork.catch(()=>{});
  if(startupCancelled||allowClose||win.isDestroyed())return;
  await Promise.all([splashStage('启动完成',100),fade(win,0,1,220)]);
  if(startupCancelled||win.isDestroyed())return;
  await fade(splash,1,0,180);
  if(startupCancelled)return;
  startupFinished=true;if(splash&&!splash.isDestroyed())splash.close();splash=null;
  if(!win.isDestroyed())win.webContents.setBackgroundThrottling(true);
 }catch(error){
  if(startupCancelled||closePending)return;
  startupFinished=true;allowClose=true;
  if(splash&&!splash.isDestroyed())splash.destroy();
  if(win&&!win.isDestroyed())win.destroy();
  if(!startupCancelled&&!closePending)dialog.showErrorBox('字幕工厂启动失败',error.message);
  app.quit();
 }
}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{
  if(startupFinished&&win&&!win.isDestroyed()){win.show();win.restore();win.focus()}
  else if(splashShown&&splash&&!splash.isDestroyed()){splash.show();splash.focus()}
 });
 app.whenReady().then(startWindows).catch(error=>{dialog.showErrorBox('字幕工厂启动失败',error.message);app.quit()});
}
function handle(name,fn){ipcMain.handle(name,async(event,...args)=>{if(event.senderFrame?.url!==pathToFileURL(path.join(__dirname,'index.html')).href)throw Error('非法调用来源');return fn(...args)})}
async function readUI(){try{return JSON.parse(await fs.readFile(path.join(dataDir,'ui.json'),'utf8'))}catch{return {}}}
handle('startup-ready',()=>{rendererInitialized=true;rendererReadyResolve?.();return true});handle('state',async()=>{const saved=await store.load().catch(()=>null);if(saved&&!pipeline.running)await pipeline.syncArtifacts(saved,{notify:false});return {tasks:pipeline.tasks,running:pipeline.running,ui:await readUI()}});
handle('files',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile','multiSelections'],filters:[{name:'视频',extensions:['mp4','mkv','mov','avi','webm']}]});return r.canceled?[]:r.filePaths});
handle('folder',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});return r.canceled?'':r.filePaths[0]});handle('model-file',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'GGUF 模型',extensions:['gguf']} ]});return r.canceled?'':r.filePaths[0]});
let adding=false;handle('add',async paths=>{if(closePending||allowClose)throw Error('软件正在退出');if(adding)throw Error('正在检查文件，请稍候');if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw Error('无效文件路径');adding=true;importPromise=pipeline.add(paths);try{return await importPromise}finally{adding=false;importPromise=null}});
handle('change',(action,id)=>{if(startPending)throw Error('任务正在准备，请稍候');return pipeline.change(action,id)});
handle('start',(settings,force=false)=>{
 if(closePending||allowClose)throw Error('软件正在退出');if(adding)throw Error('文件检查尚未结束');if(startPending||pipeline.running)throw Error('已有任务运行中');
 const data=settingsModule.validate(settings);trayPreference=data.trayOnClose;startPending=true;startCancelled=false;
 const checkStart=()=>{if(startCancelled||closePending||allowClose)throw Error('任务已取消')};
 runPromise=(async()=>{checkStart();await store.save(data);checkStart();const estimate=await pipeline.estimate(data,{force:!!force});checkStart();if(estimate.reason||!estimate.spaceEnough)throw Error(estimate.reason||'可用磁盘空间不足，任务未启动');checkStart();return pipeline.start(data,{force:!!force})})().finally(()=>{startPending=false});
 return runPromise;
});
handle('cancel',()=>{startCancelled=true;return pipeline.cancel()});
handle('open',async p=>{if(typeof p!=='string'||!path.isAbsolute(p))throw Error('路径无效');const error=await shell.openPath(p);if(error)throw Error(error)});
handle('log',async()=>{const file=path.join(dataDir,'factory.log');await fs.mkdir(dataDir,{recursive:true});await fs.appendFile(file,'');await shell.openPath(file)});
handle('cache-clear',async()=>{if(pipeline.running)throw Error('请等待任务结束');const dir=path.join(dataDir,'translation-cache');const files=await fs.readdir(dir).catch(()=>[]);const removable=files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f));for(const f of removable)await fs.unlink(path.join(dir,f));return removable.length});
handle('settings-load',async()=>{const existing=await store.load();if(existing){trayPreference=existing.trayOnClose;return existing};const base=path.join(app.getPath('appData'),'智能字幕工厂 Demo','factory-settings.json');let data=null;try{data=await settingsModule.createStore(base,safeStorage).load()}catch{}if(!data){for(const name of ['智能字幕翻译 2.43','智能字幕翻译 2.3']){try{const old=JSON.parse(await fs.readFile(path.join(app.getPath('appData'),name,'deepseek-translation-settings.json'),'utf8'));data=settingsModule.validate({...settingsModule.defaults,key:old.apiKeyEncrypted?safeStorage.decryptString(Buffer.from(old.apiKeyEncrypted,'base64')):old.apiKeyPlain||'',model:old.model||settingsModule.defaults.model,language:old.language||'中文',prompt:old.prompt||settingsModule.defaults.prompt,timeout:old.timeoutMs&&old.timeoutMs!==30000?old.timeoutMs:settingsModule.defaults.timeout,tokens:old.maxTokens||8192,genDir:old.outputDir||''});break}catch{}}}if(!data){try{const old=JSON.parse(await fs.readFile(path.join(app.getPath('appData'),'智能字幕提取','智能字幕提取-设置.json'),'utf8'));if(typeof old.context==='string')data={...settingsModule.defaults,context:old.context}}catch{}}if(data){trayPreference=data.trayOnClose;await store.save(data);return data}return null});
handle('settings-save',data=>{const checked=settingsModule.validate(data);trayPreference=checked.trayOnClose;return store.save(checked)});
handle('settings-export',async data=>{const text=settingsModule.exportText(data);const r=await dialog.showSaveDialog(win,{title:'导出设置（不含 API Key）',defaultPath:'字幕工厂设置.json',filters:[{name:'JSON',extensions:['json']}]});if(r.canceled)return false;await fs.writeFile(r.filePath,text,'utf8');return true});
handle('settings-import',async current=>{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'设置 JSON',extensions:['json']}]});if(r.canceled)return null;if((await fs.stat(r.filePaths[0])).size>1024*1024)throw Error('设置文件过大');const data=settingsModule.importText(await fs.readFile(r.filePaths[0],'utf8'),current);trayPreference=data.trayOnClose;await store.save(data);return data});
let uiWrites=Promise.resolve();handle('ui-save',raw=>{
 const height=Number(raw.promptHeight);
 const value={editDir:String(raw.editDir||''),rules:String(raw.rules||'').slice(0,10000),flagJa:!!raw.flagJa,flagEn:!!raw.flagEn};
 uiWrites=uiWrites.catch(()=>{}).then(async()=>{
  const previous=Number.isFinite(height)&&height>=44?null:await readUI();
  const valid=previous?Number(previous.promptHeight):height;
  value.promptHeight=Number.isFinite(valid)&&valid>=44?Math.min(600,Math.round(valid)):48;
  await sub.atomic(path.join(dataDir,'ui.json'),value);
 });
 return uiWrites;
});
handle('close-ready',(allow,message='')=>{if(!closePreparation)return false;closePreparation.finish(allow?null:Error(message||'退出前保存失败，窗口已保留'));return true});
handle('draft-save',data=>{
 if(data===null)return drafts.save(null);
 if(!editorReference||!editorSession)throw Error('尚未加载校对字幕');
 return drafts.save({format:'subtitle-factory-editor-draft',version:1,...editorSession,
  reference:editorReference,cues:data.cues,time:new Date().toISOString()});
});
handle('draft-load',async()=>{
 const draft=await drafts.load();if(!draft)return null;
 editorReference=draft.reference;editorSession={name:draft.name,language:draft.language,
  source:draft.source,translation:draft.translation};
 return {...editorSession,cues:draft.cues.map((cue,i)=>({...cue,original:draft.reference[i].text}))};
});
function subtitleStem(file){return path.parse(file).name.replace(/\.(?:原声|译文|成品|中文|英语|日语)(?: \(\d+\))?$/,'')}
async function openPair(source,translation,name,language){const original=await sub.read(source),translated=await sub.read(translation,{allowEmpty:true});const cues=sub.pair(original,translated,{allowMissing:true});editorReference=original;editorSession={name,language,source,translation};return {cues,...editorSession}}
handle('load-task',async id=>{const task=pipeline.tasks.find(t=>t.id===id);if(!task?.done||!task.translation)throw Error('请选择已完成翻译的任务；仅原声任务没有译文');return openPair(task.source,task.translation,path.parse(task.path).name,task.language)});
handle('import-pair',async()=>{const options={properties:['openFile'],filters:[{name:'SRT 字幕（UTF-8）',extensions:['srt']}]};const a=await dialog.showOpenDialog(win,{...options,title:'选择原声字幕'});if(a.canceled)return null;const b=await dialog.showOpenDialog(win,{...options,title:'选择对应译文字幕'});if(b.canceled)return null;return openPair(a.filePaths[0],b.filePaths[0],subtitleStem(b.filePaths[0]),null)});
handle('export',data=>{if(!editorReference)throw Error('请先加载原声与译文');const edited=sub.validateEdits(editorReference,data.cues),output=sub.renumber(edited.filter(c=>c.text.trim()));if(!output.length)throw Error('没有可输出的译文，请先补充至少一条译文');editorWrites=editorWrites.catch(()=>{}).then(async()=>{const file=await sub.save(data.dir,sub.safeName(data.name)+'.srt',output);return {file,count:output.length,omitted:edited.length-output.length}});return editorWrites});
handle('estimate',async(data,force=false)=>{const result=await pipeline.estimate(settingsModule.validate(data),{force:!!force});return {...result,allTasks:pipeline.tasks}});
handle('hide-to-tray',()=>{hideToTray();return true});
handle('quit-from-tray',async()=>{if(win&&!win.isDestroyed()){win.show();win.focus();await closeAppDirect()}return true});
const notificationAttach=setInterval(()=>{if(pipeline&&!pipeline._notificationAttached){const originalEmit=pipeline.emit.bind(pipeline);pipeline.emit=m=>{originalEmit(m);if(m?.event==='queue-finished'){try{if(Notification?.isSupported?.()!==false)new Notification({title:'智能字幕工厂',body:m.summary||'本轮任务已结束',icon:iconPath}).show()}catch(e){pipeline.log(`Windows 通知失败：${e.message}`)}}};pipeline._notificationAttached=true;clearInterval(notificationAttach)}},50);
app.on('before-quit',e=>{if(!allowClose&&win&&!win.isDestroyed()){e.preventDefault();win.close()}});app.on('window-all-closed',()=>app.quit());

