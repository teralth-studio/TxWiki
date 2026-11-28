(() => {
 const replayPath = 'M269.4,162.6c-2.7,66.5-55.6,120.1-121.8,123.9c-77,4.4-141.3-60-136.8-136.9C14.7,81.7,71,27.8,140,27.8c1.8,0,3.5,0,5.3,0.1c0.3,0,0.5,0.2,0.5,0.5v15c0,1.5,1.6,2.4,2.9,1.7l35.9-20.7c1.3-0.7,1.3-2.6,0-3.3L148.6,0.3c-1.3-0.7-2.9,0.2-2.9,1.7v15c0,0.3-0.2,0.5-0.5,0.5c-1.7-0.1-3.5-0.1-5.2-0.1C63.3,17.3,1,78.9,0,155.4C-1,233.8,63.4,298.3,141.9,297.3c74.6-1,135.1-60.2,138-134.3c0.1-3-2.3-5.4-5.3-5.4C271.8,157.6,269.5,159.8,269.4,162.6z';
 const controllers = new WeakMap();
 function mount(screen, { message, home = '/', backLabel = 'Go back', replayLabel = 'Replay animation' } = {}) {
  controllers.get(screen)?.();
  screen.classList.remove('not-found-page');
  screen.classList.add('tx-error-screen');
  screen.setAttribute('aria-label', String(message));
  screen.replaceChildren();
  const container = document.createElement('div'); container.className = 'copy-container center-xy';
  const copy = document.createElement('p'); copy.className = 'error-copy';
  const accessible = document.createElement('span'); accessible.className = 'error-accessible-copy'; accessible.textContent = message;
  const visual = document.createElement('span'); visual.setAttribute('aria-hidden','true');
  const chars = [];
  for (const word of String(message).split(/(\s+)/)) {
   if (/^\s+$/.test(word)) { visual.append(document.createTextNode(word)); continue; }
   const element = document.createElement('span'); element.className = 'error-word';
   for (const letter of Array.from(word)) { const char = document.createElement('span'); char.className = 'error-char'; char.textContent = letter; chars.push(char); element.append(char); }
   visual.append(element);
  }
  copy.append(accessible, visual);
  const handle = document.createElement('span'); handle.className = 'handle'; handle.setAttribute('aria-hidden','true');
  container.append(copy,handle);
  const replay = document.createElement('button'); replay.className = 'error-replay'; replay.type = 'button'; replay.setAttribute('aria-label',replayLabel);
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 279.9 297.3'); svg.setAttribute('aria-hidden','true');
  const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',replayPath); svg.append(path); replay.append(svg);
  const back = document.createElement('a'); back.className = 'error-home'; back.href = home; back.textContent = backLabel;
  container.append(back);
  screen.append(container,replay);
  if (screen.id === 'fatalBox') {
   document.getElementById('app')?.setAttribute('inert','');
   screen.setAttribute('tabindex','-1');
   screen.focus({preventScroll:true});
  }
  let timer, shown=0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function placeHandle() {
   const target = chars[Math.max(0,shown-1)]; if (!target) return;
   const box=target.getBoundingClientRect(), parent=container.getBoundingClientRect();
   const left=(shown ? box.right : box.left)-parent.left+2;
   handle.style.left=Math.min(left,screen.clientWidth-parent.left-handle.offsetWidth-8)+'px';
   handle.style.top=(box.top-parent.top+(box.height-handle.offsetHeight)/2)+'px';
  }
  function play() {
   clearTimeout(timer); shown = reduced.matches ? chars.length : 0;
   chars.forEach(char=>char.classList.toggle('is-visible',reduced.matches));
   handle.style.animation='none'; void handle.offsetWidth; handle.style.animation='';
   placeHandle();
   if (reduced.matches) return;
   const tick=()=>{ if (!screen.isConnected) { cleanup(); return; } if(shown < chars.length){ chars[shown++].classList.add('is-visible'); placeHandle(); timer=setTimeout(tick,50); } };
   timer=setTimeout(tick,200);
  }
  function cleanup() { clearTimeout(timer); window.removeEventListener('resize',placeHandle); reduced.removeEventListener('change',play); }
  replay.onclick=play;
  window.addEventListener('resize',placeHandle); reduced.addEventListener('change',play);
  controllers.set(screen,cleanup);
  document.fonts?.ready.then(()=>{ if(screen.isConnected) placeHandle(); });
  play();
 }
 window.TxWikiErrors={mount, unmount: screen => { if (screen) { controllers.get(screen)?.(); controllers.delete(screen); } }};
 document.querySelectorAll('[data-error-message]').forEach(screen=>mount(screen,{message:screen.dataset.errorMessage}));
})();
