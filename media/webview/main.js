// Secondary Simulator webview.
// 入力は生の Pointer Events をそのまま拡張ホストへ流す（Phase 1）。
// タップ/スワイプ/ロングプレスの判定は端末側が行うため、ドラッグに画面が追従する。
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('simulator-canvas');
const ctx = canvas.getContext('2d');
const img = document.getElementById('simulator-img');
const overlay = document.getElementById('overlay');
const container = document.getElementById('simulator-container');
const touchOverlay = document.getElementById('touch-overlay');
const octx = touchOverlay.getContext('2d');
const deviceSelect = document.getElementById('device');
const resourcesEl = document.getElementById('resources');
const lamp = document.getElementById('lamp');

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 直結ストリーム時は <img>、それ以外は canvas が表示要素になる
let usingImg = false;
function displayEl() {
  return usingImg ? img : canvas;
}

// ---- 生ポインタ入力 ----------------------------------------------------------

const pointers = new Map(); // pointerId -> {x, y} 正規化座標
const order = []; // pointerId の順序
let mode = 0; // 0=なし, 1=1本指, 2=2本指
let lastSingle = {x: 0, y: 0};
let lastPair = [
  {x: 0, y: 0},
  {x: 0, y: 0},
];
let moveScheduled = false;
let trailPoints = [];

function norm(e) {
  const r = displayEl().getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01((e.clientY - r.top) / r.height),
  };
}

function post(type, extra) {
  vscode.postMessage(Object.assign({type}, extra));
}

function activePair() {
  return [pointers.get(order[0]), pointers.get(order[1])];
}

function onPointerDown(e) {
  container.setPointerCapture?.(e.pointerId);
  const p = norm(e);
  if (!pointers.has(e.pointerId)) order.push(e.pointerId);
  pointers.set(e.pointerId, p);

  const count = order.length;
  if (count === 1) {
    mode = 1;
    lastSingle = p;
    post('touchDown', {x: p.x, y: p.y});
    showRipple(e);
    trailPoints = [p];
  } else if (count === 2) {
    // 1本指セッションを閉じ、2本指を開始
    if (mode === 1) post('touchUp', {x: lastSingle.x, y: lastSingle.y});
    const [a, b] = activePair();
    lastPair = [a, b];
    mode = 2;
    post('touch2Down', {x: a.x, y: a.y, x2: b.x, y2: b.y});
    clearTrail();
  }
  e.preventDefault();
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, norm(e));
  if (!moveScheduled) {
    moveScheduled = true;
    requestAnimationFrame(flushMove);
  }
  e.preventDefault();
}

function flushMove() {
  moveScheduled = false;
  if (mode === 1) {
    const p = pointers.get(order[0]);
    if (p) {
      lastSingle = p;
      post('touchMove', {x: p.x, y: p.y});
      pushTrail(p);
    }
  } else if (mode === 2) {
    const [a, b] = activePair();
    if (a && b) {
      lastPair = [a, b];
      post('touch2Move', {x: a.x, y: a.y, x2: b.x, y2: b.y});
    }
  }
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  const p = norm(e);
  pointers.delete(e.pointerId);
  const idx = order.indexOf(e.pointerId);
  if (idx >= 0) order.splice(idx, 1);
  const count = order.length;

  if (mode === 2) {
    const [a, b] = lastPair;
    post('touch2Up', {x: a.x, y: a.y, x2: b.x, y2: b.y});
    mode = 0;
    if (count === 1) {
      // 残った指で1本指セッションを継続
      const r = pointers.get(order[0]);
      if (r) {
        mode = 1;
        lastSingle = r;
        post('touchDown', {x: r.x, y: r.y});
      }
    }
  } else if (mode === 1) {
    post('touchUp', {x: p.x, y: p.y});
    mode = 0;
    clearTrail();
  }
  e.preventDefault();
}

// コンテナに束ねて、canvas / img どちらが表示中でも入力を受ける
container.addEventListener('pointerdown', onPointerDown);
container.addEventListener('pointermove', onPointerMove);
container.addEventListener('pointerup', onPointerUp);
container.addEventListener('pointercancel', onPointerUp);

// ---- 楽観的フィードバック（リップル・軌跡）----------------------------------

function showRipple(e) {
  if (!trailEnabled) return;
  const r = container.getBoundingClientRect();
  const dot = document.createElement('div');
  dot.className = 'touch-ripple';
  dot.style.left = e.clientX - r.left + 'px';
  dot.style.top = e.clientY - r.top + 'px';
  container.appendChild(dot);
  setTimeout(() => dot.remove(), 400);
}

function syncOverlaySize() {
  const r = displayEl().getBoundingClientRect();
  if (touchOverlay.width !== Math.round(r.width) || touchOverlay.height !== Math.round(r.height)) {
    touchOverlay.width = Math.round(r.width);
    touchOverlay.height = Math.round(r.height);
  }
}

function pushTrail(p) {
  if (!trailEnabled) return;
  trailPoints.push(p);
  if (trailPoints.length > 40) trailPoints.shift();
  drawTrail();
}

function drawTrail() {
  syncOverlaySize();
  const w = touchOverlay.width;
  const h = touchOverlay.height;
  octx.clearRect(0, 0, w, h);
  if (trailPoints.length < 2) return;
  octx.strokeStyle =
    getComputedStyle(document.documentElement).getPropertyValue('--vscode-focusBorder') ||
    '#007acc';
  octx.lineWidth = 3;
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  octx.beginPath();
  for (let i = 0; i < trailPoints.length; i++) {
    const x = trailPoints[i].x * w;
    const y = trailPoints[i].y * h;
    octx.globalAlpha = (i + 1) / trailPoints.length;
    if (i === 0) octx.moveTo(x, y);
    else octx.lineTo(x, y);
  }
  octx.stroke();
  octx.globalAlpha = 1;
}

function clearTrail() {
  trailPoints = [];
  octx.clearRect(0, 0, touchOverlay.width, touchOverlay.height);
}

// ---- キーボード --------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // デバイス未選択（オーバーレイ表示中）ならキー入力を送らない
  if (!overlay.classList.contains('hidden')) return;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return;

  if (e.key === 'Backspace') {
    post('keypress', {key: 'delete', special: true});
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter') {
    post('keypress', {key: 'return', special: true});
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    post('keypress', {key: 'escape', special: true});
    e.preventDefault();
    return;
  }
  if (e.key.length === 1) {
    post('keypress', {key: e.key});
    e.preventDefault();
  }
});

// ---- デバイス選択・ボタン ----------------------------------------------------

const btnBack = document.getElementById('btn-back');
const platformById = new Map(); // deviceId -> 'ios' | 'android'

// iOS に Back は存在しないので押せないようにする（未選択時も同様）
function syncBackButton() {
  btnBack.disabled = platformById.get(deviceSelect.value) !== 'android';
}

deviceSelect.addEventListener('change', () => {
  syncBackButton();
  vscode.postMessage({type: 'deviceChange', deviceId: deviceSelect.value});
});
document.getElementById('btn-home').addEventListener('click', () => post('home'));
btnBack.addEventListener('click', () => post('back'));
document
  .getElementById('btn-disconnect')
  .addEventListener('click', () => post('disconnect'));
document
  .getElementById('btn-refresh')
  .addEventListener('click', () => post('refresh'));

// タップのリップルとドラッグ軌跡の表示切替。状態は webview の state に残す。
const btnTrail = document.getElementById('btn-trail');
let trailEnabled = vscode.getState()?.trail ?? true;

function syncTrailButton() {
  btnTrail.classList.toggle('on', trailEnabled);
  btnTrail.textContent = trailEnabled ? 'Trail ON' : 'Trail OFF';
  if (!trailEnabled) clearTrail();
}

btnTrail.addEventListener('click', () => {
  trailEnabled = !trailEnabled;
  vscode.setState(Object.assign({}, vscode.getState(), {trail: trailEnabled}));
  syncTrailButton();
});
syncTrailButton();

// ---- レンダリング（MJPEG フレーム）------------------------------------------

let frameQueue = [];
let currentBitmap = null;
let isRendering = false;
const MAX_FRAME_QUEUE = 1; // 最新フレームのみ保持

function normalizeToUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data?.data && Array.isArray(data.data)) return new Uint8Array(data.data);
  if (Array.isArray(data)) return new Uint8Array(data);
  return null;
}

async function renderFrame(bytes) {
  if (!bytes) return;
  try {
    const blob = new Blob([bytes], {type: 'image/jpeg'});
    const bitmap = await createImageBitmap(blob);
    if (currentBitmap) {
      currentBitmap.close?.();
      currentBitmap = null;
    }
    currentBitmap = bitmap;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    if (currentBitmap && ctx) {
      ctx.drawImage(currentBitmap, 0, 0, canvas.width, canvas.height);
    }
  } catch (err) {
    console.error('renderFrame failed', err);
  }
}

function dequeueAndRender() {
  if (isRendering || frameQueue.length === 0) return;
  isRendering = true;
  const bytes = frameQueue.shift();
  if (!bytes) {
    isRendering = false;
    return;
  }
  renderFrame(bytes).finally(() => {
    isRendering = false;
    dequeueAndRender();
  });
}

function enqueueFrame(bytes) {
  if (!bytes) return;
  if (frameQueue.length >= MAX_FRAME_QUEUE) frameQueue = [];
  frameQueue.push(bytes);
  dequeueAndRender();
}

function setOverlayVisible(visible, text = 'Select a device to start') {
  if (!overlay) return;
  // 画面が出ている＝接続中。オーバーレイの表示状態がそのまま接続状態になる。
  lamp.classList.toggle('on', !visible);
  lamp.title = visible ? '切断中' : '接続中';
  overlay.classList.toggle('hidden', !visible);
  overlay.querySelector('span').textContent = text;
  // 表示中のメディア要素だけを見せる
  const el = displayEl();
  el.style.display = visible ? 'none' : 'block';
  if (visible) {
    canvas.style.display = 'none';
    img.style.display = 'none';
  }
}

function cleanup() {
  if (currentBitmap) {
    currentBitmap.close?.();
    currentBitmap = null;
  }
  frameQueue = [];
  isRendering = false;
  clearTrail();
  pointers.clear();
  order.length = 0;
  mode = 0;
  // 直結ストリームを停止（接続を閉じる）
  if (usingImg) {
    img.src = '';
    usingImg = false;
  }
}

// ---- 拡張ホストからのメッセージ ----------------------------------------------

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'devices': {
      const selected = deviceSelect.value;
      deviceSelect.innerHTML = '<option value="">Select Device...</option>';
      platformById.clear();
      message.devices.forEach((device) => {
        platformById.set(device.id, device.platform);
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = `${device.name} (${device.state})`;
        deviceSelect.appendChild(option);
      });
      // 再取得しても選択中のデバイスは維持する。消えていたらホストのキャプチャも止める。
      const next = platformById.has(selected) ? selected : '';
      deviceSelect.value = next;
      syncBackButton();
      if (selected && next === '') {
        vscode.postMessage({type: 'deviceChange', deviceId: ''});
        cleanup();
        setOverlayVisible(true, 'Disconnected — デバイスを選び直すと再接続します');
      }
      break;
    }

    case 'streamUrl': {
      // Phase 2: <img> に MJPEG を直結。Chromium が multipart をネイティブ復号する。
      // 初回は WDA 起動待ちで最初のフレームまで数秒かかることがあるため、
      // 実際に表示できるまでオーバーレイで待機中を示す。
      usingImg = true;
      canvas.style.display = 'none';
      img.style.display = 'none';
      setOverlayVisible(true, 'ストリームに接続中…');
      // setOverlayVisible(false) が displayEl()（= img）を表示状態にする
      img.onload = () => setOverlayVisible(false);
      img.onerror = () => setOverlayVisible(true, 'ストリームに接続できません');
      img.src = message.url;
      break;
    }

    case 'frame':
      usingImg = false;
      img.style.display = 'none';
      enqueueFrame(normalizeToUint8Array(message.data));
      setOverlayVisible(false);
      break;

    case 'resources':
      resourcesEl.textContent =
        `拡張ホスト ${message.rssMb}MB (heap ${message.heapUsedMb}MB)` +
        ` ・ 子プロセス ${message.childrenMb}MB ・ ストレージ ${message.storageMb}MB`;
      break;

    case 'status':
      // 互換モード等の状態表示（オーバーレイは触らない）
      break;

    case 'error':
      cleanup();
      setOverlayVisible(true, message.text);
      break;

    case 'disconnected':
      cleanup();
      // 同じデバイスを選び直しても change が飛ぶように選択を空へ戻す（復帰導線）
      deviceSelect.value = '';
      syncBackButton();
      setOverlayVisible(true, 'Disconnected — デバイスを選び直すと再接続します');
      break;

    case 'pauseStream':
      // 非表示・切替時。overlay は触らず接続だけ閉じる（再開時に streamUrl が来る）
      if (usingImg) {
        img.src = '';
      }
      break;
  }
});

window.addEventListener('resize', () => {
  if (currentBitmap) ctx.drawImage(currentBitmap, 0, 0, canvas.width, canvas.height);
});
window.addEventListener('beforeunload', cleanup);

vscode.postMessage({type: 'init'});
