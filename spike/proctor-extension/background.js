// Service worker — proves the extension sees tab/window/navigation events BROWSER-WIDE,
// across every tab and window, regardless of origin. Open chrome://extensions →
// "Proctor Extension Spike" → "service worker" (Inspect) to watch these live.
let switches = 0;

const log = (...a) => console.log('%c[proctor-bg]', 'color:#2563eb', ...a);

chrome.tabs.onActivated.addListener(async (info) => {
  switches++;
  try {
    const t = await chrome.tabs.get(info.tabId);
    log(`tab switch #${switches} → "${t.title}"  ${t.url}`);
  } catch (e) {
    log(`tab switch #${switches} (could not read tab)`);
  }
});

chrome.tabs.onCreated.addListener((t) => log('NEW TAB opened →', t.pendingUrl || t.url || '(blank)'));
chrome.tabs.onRemoved.addListener((id) => log('tab closed →', id));

chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) log('⚠️ focus LEFT the browser entirely (switched to another app)');
  else log('window focus → window', winId);
});

chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId === 0) log('navigation committed →', d.url);
});

log('Proctor spike service worker started. Switch tabs / open new tabs / alt-tab to another app and watch.');
