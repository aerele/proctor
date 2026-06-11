(() => {
  // ---- Fake media stream via canvas.captureStream ----
  function makeCanvasStream(label, surface) {
    const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, 320, 240);
    // keep the canvas changing so the track stays "live"
    setInterval(() => {
      ctx.fillStyle = `hsl(${Date.now() / 50 % 360},50%,30%)`;
      ctx.fillRect(0, 0, 320, 240);
    }, 200);
    const stream = canvas.captureStream(10);
    stream.getVideoTracks().forEach((t) => {
      try { Object.defineProperty(t, 'label', { value: label, configurable: true }); } catch (e) {}
      const orig = t.getSettings ? t.getSettings.bind(t) : () => ({});
      t.getSettings = () => Object.assign({}, orig(), surface ? { displaySurface: surface } : {});
      t.applyConstraints = () => Promise.resolve();
    });
    return stream;
  }

  function audioTrack() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const dst = ac.createMediaStreamDestination();
      const osc = ac.createOscillator(); osc.connect(dst); osc.start();
      return dst.stream.getAudioTracks()[0];
    } catch (e) { return null; }
  }

  const md = navigator.mediaDevices || {};
  md.getDisplayMedia = async () => makeCanvasStream('Fake Screen', 'monitor');
  md.getUserMedia = async (constraints) => {
    const tracks = [];
    if (constraints && constraints.video) {
      tracks.push(...makeCanvasStream('Fake Camera').getVideoTracks());
    }
    if (constraints && constraints.audio) {
      const a = audioTrack(); if (a) tracks.push(a);
    }
    return new MediaStream(tracks);
  };
  md.enumerateDevices = async () => ([
    { deviceId: 'cam1', kind: 'videoinput', label: 'Fake Camera', groupId: 'g1', toJSON() { return this; } },
    { deviceId: 'mic1', kind: 'audioinput', label: 'Fake Mic', groupId: 'g1', toJSON() { return this; } },
  ]);
  try { Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true }); } catch (e) {}

  // ---- Fullscreen stub (headless has no real fullscreen) ----
  let fsEl = null;
  function setFs(el) {
    fsEl = el;
    try { Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true }); } catch (e) {}
    document.dispatchEvent(new Event('fullscreenchange'));
  }
  Element.prototype.requestFullscreen = function () { setFs(this); return Promise.resolve(); };
  document.exitFullscreen = function () { setFs(null); return Promise.resolve(); };
  try { Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true }); } catch (e) {}

  // expose helpers for the test driver
  window.__e2e = {
    exitFullscreen: () => { setFs(null); },
    enterFullscreen: () => { setFs(document.documentElement); },
    isFs: () => Boolean(fsEl),
  };
})();
