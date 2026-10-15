const {contextBridge,ipcRenderer,webUtils}=require('electron');
const call=(name,...args)=>ipcRenderer.invoke(name,...args);
contextBridge.exposeInMainWorld('desktop',{
 state:()=>call('state'),files:()=>call('files'),folder:()=>call('folder'),modelFile:()=>call('model-file'),
 add:paths=>call('add',paths),change:(a,id)=>call('change',a,id),estimate:(data,force=false)=>call('estimate',data,!!force),
 start:(data,force=false)=>call('start',data,!!force),cancel:()=>call('cancel'),open:p=>call('open',p),
 log:()=>call('log'),clearCache:()=>call('cache-clear'),path:file=>webUtils.getPathForFile(file),
 loadSettings:()=>call('settings-load'),saveSettings:d=>call('settings-save',d),exportSettings:d=>call('settings-export',d),
 importSettings:d=>call('settings-import',d),saveUI:d=>call('ui-save',d),saveDraft:d=>call('draft-save',d),
 loadDraft:()=>call('draft-load'),startupReady:()=>call('startup-ready'),
 onPrepareClose:callback=>{ipcRenderer.on('prepare-close',()=>callback())},
 finishClose:(allow,message='')=>call('close-ready',allow,message),hideToTray:()=>call('hide-to-tray'),
 quitFromTray:()=>call('quit-from-tray'),loadTask:id=>call('load-task',id),importPair:()=>call('import-pair'),
 export:d=>call('export',d),onProgress:callback=>{ipcRenderer.on('factory-progress',(_,m)=>callback(m))}
});
