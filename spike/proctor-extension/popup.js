async function scan() {
  const host = document.getElementById('tabs');
  host.textContent = 'scanning…';
  const wins = await chrome.windows.getAll({ populate: true });
  const totalTabs = wins.reduce((n, w) => n + (w.tabs ? w.tabs.length : 0), 0);
  const parts = [];
  parts.push(`<div><span class="count">${wins.length}</span> window(s), <span class="count">${totalTabs}</span> tab(s) — all visible to the extension:</div>`);
  wins.forEach((w, i) => {
    parts.push(`<div class="win">Window ${i + 1}${w.focused ? ' (focused)' : ''}</div><ul>`);
    (w.tabs || []).forEach((t) => {
      const title = (t.title || '(no title)').replace(/</g, '&lt;');
      const url = (t.url || t.pendingUrl || '').replace(/</g, '&lt;');
      parts.push(`<li class="tab">${t.active ? '▶ ' : ''}${title}<br><span class="u">${url}</span></li>`);
    });
    parts.push('</ul>');
  });
  host.innerHTML = parts.join('');
}
document.getElementById('scan').addEventListener('click', scan);
scan();
