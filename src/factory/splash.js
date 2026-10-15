window.setStartupStage=async(text,percent)=>{
 const n=Math.max(0,Math.min(100,Number(percent)||0)),bar=document.getElementById('bar');
 document.getElementById('stage').textContent=text;bar.style.width=n+'%';
 document.getElementById('percent').textContent=n+'%';
 document.querySelectorAll('.step').forEach(el=>{const at=Number(el.dataset.at||0);
  el.classList.toggle('done',n>at+20);el.classList.toggle('active',n>=at&&n<=at+20)});
 if(n===100){
  await new Promise(resolve=>requestAnimationFrame(resolve));
  await Promise.all(bar.getAnimations().map(animation=>animation.finished.catch(()=>{})));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 }
 return true;
};
