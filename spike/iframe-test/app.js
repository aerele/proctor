const $ = (id) => document.getElementById(id);
const log = (m) => { const el=$('log'); const t=new Date().toISOString().slice(11,19); el.textContent += `[${t}] ${m}\n`; el.scrollTop=el.scrollHeight; };
const setPill = (id, text, cls) => { const e=$(id); if(!e) return; e.textContent=text; e.className='pill '+cls; };

// ---------- Extension detection (DOM marker + postMessage handshake) ----------
function setExt(v) {
  if (v) { setPill('extStatus','✅ Extension INSTALLED (v'+v+')','ok'); setPill('aStatus','installed v'+v,'ok'); $('extDetail').textContent='Detected. The page can now talk to the extension.'; }
  else { setPill('extStatus','⛔ Extension NOT detected','bad'); setPill('aStatus','not installed','bad'); $('extDetail').textContent='After installing, click Re-check (or reload).'; }
}
window.addEventListener('message', (e) => {
  if (e.source===window && e.data && e.data.source==='proctor-ext' && (e.data.type==='present'||e.data.type==='pong')) {
    setExt(e.data.version); log('Extension announced itself: v'+e.data.version);
  }
});
function checkExt() {
  const attr = document.documentElement.getAttribute('data-proctor-ext');
  if (attr) { setExt(attr); return; }
  setExt(null);
  window.postMessage({ source:'proctor-page', type:'ping' }, '*');  // wait for pong via listener
  log('Probed for extension (ping sent). No response = not installed.');
}
$('recheck').onclick = checkExt;
$('reload').onclick = () => location.reload();

// ---------- Fullscreen + lockdown demo ----------
let fsExits = 0, countTimer = null;
$('fs').onclick = () => (document.documentElement.requestFullscreen?.()||Promise.reject()).then(()=>log('entered fullscreen')).catch(e=>log('requestFullscreen failed: '+e));
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement; log('fullscreenchange → ' + (on?'ENTERED':'EXITED'));
  if (!on) handleFsExit();
});
function handleFsExit(){
  fsExits++; $('d-fsx').textContent = fsExits; stamp('fullscreen-exit #'+fsExits);
  if (fsExits >= 2) { showLock(); return; }
  let n = Math.max(1, parseInt($('grace').value||'8',10)); $('warnCount').textContent=n;
  $('warn').style.display='flex'; $('warnInput').value=''; $('warnInput').focus();
  clearInterval(countTimer);
  countTimer = setInterval(()=>{ n--; $('warnCount').textContent=n; if(n<=0){clearInterval(countTimer);$('warn').style.display='none';showLock();} },1000);
}
$('warnOk').onclick = () => { if ($('warnInput').value.trim().toLowerCase()==='i will not exit full screen'){clearInterval(countTimer);$('warn').style.display='none';log('1st exit acknowledged');} else {$('warnInput').focus();} };
function showLock(){ clearInterval(countTimer); $('warn').style.display='none'; $('lock').style.display='flex'; $('lockInput').focus(); log('LOCKED (exit #'+fsExits+')'); }
$('lockOk').onclick = () => { if ($('lockInput').value.trim()==='1234'){$('lock').style.display='none';fsExits=0;log('unlocked');} else {$('lockInput').focus();} };

// ---------- Tab-away / focus detection (this tab) ----------
let hidCount=0, blurCount=0;
const stamp = (m) => log(m);
function refreshState(){
  const vis = document.visibilityState; setPill('d-vis', vis, vis==='visible'?'ok':'bad');
  const foc = document.hasFocus(); setPill('d-foc', foc?'yes':'no', foc?'ok':'bad');
}
document.addEventListener('visibilitychange', () => { if(document.visibilityState==='hidden'){hidCount++;$('d-hid').textContent=hidCount;} log('visibilitychange → '+document.visibilityState); refreshState(); });
window.addEventListener('blur', () => { blurCount++; $('d-blur').textContent=blurCount; log('window blur (left this tab/window)'); refreshState(); });
window.addEventListener('focus', () => { log('window focus (returned)'); refreshState(); });

// ---------- Cross-tab probe ----------
let childWin = null;
$('openTab').onclick = () => {
  childWin = window.open('https://www.hackerrank.com/coding-contest-mcet-june-2026-slot-2', '_blank');
  if (!childWin) { log('window.open returned null (popup blocked?)'); return; }
  log('Opened HackerRank in a new tab. Probing what THIS tab can read about it…');
  setTimeout(() => {
    const cannot = [];
    try { log('✅ CAN read: child.closed=' + childWin.closed); } catch(e){ cannot.push('closed:'+e.name); }
    try { childWin.document.fullscreenElement; } catch(e){ cannot.push('fullscreen:'+e.name); }
    try { childWin.document.visibilityState; } catch(e){ cannot.push('visibility:'+e.name); }
    try { childWin.location.href; } catch(e){ cannot.push('url:'+e.name); }
    log('⛔ CANNOT read (SecurityError): ' + cannot.join('  |  '));
    log('CONCLUSION: this tab cannot see the other tab’s fullscreen / visibility / URL → a browser extension is required to monitor a separate HackerRank tab.');
  }, 1500);
};

// init
refreshState();
checkExt();
log('Page ready. Install the extension, then Re-check.');
