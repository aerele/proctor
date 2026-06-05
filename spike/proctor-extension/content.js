// Runs on the proctor page (localhost). Announces the extension's presence so the page
// can detect whether it's installed — via a DOM marker + a postMessage handshake.
const VERSION = chrome.runtime.getManifest().version;

try { document.documentElement.setAttribute('data-proctor-ext', VERSION); } catch (e) {}

function announce() {
  window.postMessage({ source: 'proctor-ext', type: 'present', version: VERSION }, '*');
}

window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.source === 'proctor-page' && e.data.type === 'ping') {
    window.postMessage({ source: 'proctor-ext', type: 'pong', version: VERSION }, '*');
  }
});

announce();
setTimeout(announce, 300);
document.addEventListener('DOMContentLoaded', announce);
