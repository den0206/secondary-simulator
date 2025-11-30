const vscode = acquireVsCodeApi();
const canvas = document.getElementById('simulator-canvas');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const platformSelect = document.getElementById('platform');
const deviceSelect = document.getElementById('device');
const overlayToggle = document.getElementById('toggle-overlay');

// Touch/Mouse event handling for tap and swipe (mobiledeck-style)
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Gesture state (mobiledeck-style)
let gestureState = {
  isGesturing: false,
  startTime: 0,
  lastTimestamp: 0,
  points: [], // Array of {x, y, duration}
  path: [], // Array of [x, y] for visual feedback
};

let isDragging = false;
let startX = 0;
let startY = 0;
let startTime = 0;
let lastTapTime = 0;
let longPressTimer = null;
let longPressTriggered = false;
let SWIPE_THRESHOLD = 30; // minimum pixels for swipe
let TAP_THRESHOLD = 10; // maximum pixels for tap
let SHOW_GESTURE_OVERLAY = true;
let LONG_PRESS_DURATION = 600;
const DOUBLE_TAP_INTERVAL = 300;
const GESTURE_THRESHOLD_MS = 100; // mobiledeck: 100ms以内はタップ、それ以上はジェスチャー

// Screen size for coordinate conversion (will be set from extension)
let screenSize = {width: 0, height: 0};

// Convert canvas coordinates to screen coordinates (mobiledeck-style)
function convertToScreenCoords(clientX, clientY, element) {
  const rect = element.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  // If screen size is available, convert to screen coordinates
  // Otherwise, use normalized coordinates (0-1)
  if (screenSize.width > 0 && screenSize.height > 0) {
    const screenX = Math.floor((x / rect.width) * screenSize.width);
    const screenY = Math.floor((y / rect.height) * screenSize.height);
    return {x, y, screenX, screenY};
  } else {
    // Fallback to normalized coordinates
    const normalizedX = clamp01(x / rect.width);
    const normalizedY = clamp01(y / rect.height);
    return {x, y, screenX: normalizedX, screenY: normalizedY};
  }
}

// Visual feedback functions (mobiledeck-inspired)
function showTapFeedback(x, y) {
  if (!SHOW_GESTURE_OVERLAY) return;
  const feedback = document.getElementById('gesture-feedback');
  if (!feedback) return;

  const ripple = document.createElement('div');
  ripple.style.position = 'absolute';
  ripple.style.left = x - 20 + 'px';
  ripple.style.top = y - 20 + 'px';
  ripple.style.width = '40px';
  ripple.style.height = '40px';
  ripple.style.borderRadius = '50%';
  ripple.style.background = 'rgba(33, 150, 243, 0.5)';
  ripple.style.animation = 'ripple 0.6s ease-out';
  ripple.style.pointerEvents = 'none';

  feedback.appendChild(ripple);

  setTimeout(() => {
    ripple.remove();
  }, 600);
}

function showSwipeFeedback(x1, y1, x2, y2) {
  if (!SHOW_GESTURE_OVERLAY) return;
  const feedback = document.getElementById('gesture-feedback');
  if (!feedback) return;

  const line = document.createElement('div');
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const length = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

  line.style.position = 'absolute';
  line.style.left = x1 + 'px';
  line.style.top = y1 + 'px';
  line.style.width = length + 'px';
  line.style.height = '3px';
  line.style.background = 'rgba(76, 175, 80, 0.7)';
  line.style.transformOrigin = '0 0';
  line.style.transform = 'rotate(' + angle + 'deg)';
  line.style.animation = 'fadeOut 0.5s ease-out';
  line.style.pointerEvents = 'none';

  feedback.appendChild(line);

  setTimeout(() => {
    line.remove();
  }, 500);
}

canvas.addEventListener('mousedown', (e) => {
  isDragging = true;
  const coords = convertToScreenCoords(e.clientX, e.clientY, e.currentTarget);
  const now = Date.now();

  startX = coords.x;
  startY = coords.y;
  startTime = now;

  // Initialize gesture state (mobiledeck-style)
  // durationは累積時間（最初のポイントからの経過時間）として記録
  gestureState = {
    isGesturing: false,
    startTime: now,
    lastTimestamp: now,
    points: [{x: coords.screenX, y: coords.screenY, duration: 0}], // 最初のポイントは0ms
    path: [[coords.x, coords.y]],
  };

  longPressTriggered = false;
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    const x =
      screenSize.width > 0
        ? clamp01(coords.screenX / screenSize.width)
        : clamp01(startX / canvas.getBoundingClientRect().width);
    const y =
      screenSize.height > 0
        ? clamp01(coords.screenY / screenSize.height)
        : clamp01(startY / canvas.getBoundingClientRect().height);
    vscode.postMessage({
      type: 'longPress',
      x,
      y,
      duration: LONG_PRESS_DURATION,
    });
    showTapFeedback(startX, startY);
  }, LONG_PRESS_DURATION);
  e.preventDefault();
});

canvas.addEventListener('mousemove', (e) => {
  if (!isDragging || gestureState.points.length === 0) return;

  const coords = convertToScreenCoords(e.clientX, e.clientY, e.currentTarget);
  const now = Date.now();

  // mobiledeck: 100ms以上経過したらジェスチャーとして収集開始
  if (
    !gestureState.isGesturing &&
    now - gestureState.startTime > GESTURE_THRESHOLD_MS
  ) {
    gestureState.isGesturing = true;
  }

  // ジェスチャー中、または100ms以上経過している場合はポイントを収集
  if (
    gestureState.isGesturing ||
    now - gestureState.startTime > GESTURE_THRESHOLD_MS
  ) {
    // durationは累積時間（最初のポイントからの経過時間）として記録
    const duration = now - gestureState.startTime;
    const newPoint = {x: coords.screenX, y: coords.screenY, duration};
    gestureState.points.push(newPoint);
    gestureState.path.push([coords.x, coords.y]);
    gestureState.lastTimestamp = now;
    gestureState.isGesturing = true;
  }

  // ロングプレスタイマーをキャンセル
  const deltaX = coords.x - startX;
  const deltaY = coords.y - startY;
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  if (distance > TAP_THRESHOLD && longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  e.preventDefault();
});

canvas.addEventListener('mouseup', (e) => {
  if (!isDragging || gestureState.points.length === 0) return;
  isDragging = false;

  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  const coords = convertToScreenCoords(e.clientX, e.clientY, e.currentTarget);
  const now = Date.now();

  if (longPressTriggered) {
    // already handled
  } else if (gestureState.isGesturing) {
    // mobiledeck: ジェスチャーとして送信
    // durationは累積時間（最初のポイントからの経過時間）として記録
    const duration = now - gestureState.startTime;
    const finalPoints = [
      ...gestureState.points,
      {x: coords.screenX, y: coords.screenY, duration},
    ];

    // 正規化座標に変換（mobilecliは正規化座標を受け取る）
    const normalizedPoints = finalPoints.map((p) => ({
      x: screenSize.width > 0 ? clamp01(p.x / screenSize.width) : p.x,
      y: screenSize.height > 0 ? clamp01(p.y / screenSize.height) : p.y,
      duration: p.duration,
    }));

    vscode.postMessage({type: 'gesture', points: normalizedPoints});
    showSwipeFeedback(startX, startY, coords.x, coords.y);
  } else {
    // タップとして処理
    const deltaX = coords.x - startX;
    const deltaY = coords.y - startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    if (distance < TAP_THRESHOLD) {
      const x =
        screenSize.width > 0
          ? clamp01(coords.screenX / screenSize.width)
          : clamp01(coords.x / canvas.getBoundingClientRect().width);
      const y =
        screenSize.height > 0
          ? clamp01(coords.screenY / screenSize.height)
          : clamp01(coords.y / canvas.getBoundingClientRect().height);
      const now = Date.now();
      if (now - lastTapTime < DOUBLE_TAP_INTERVAL) {
        vscode.postMessage({type: 'doubleTap', x, y});
        lastTapTime = 0;
      } else {
        vscode.postMessage({type: 'tap', x, y});
        lastTapTime = now;
      }
      showTapFeedback(coords.x, coords.y);
    } else {
      // 距離が大きい場合はスワイプとして処理（後方互換性のため）
      const x1 =
        screenSize.width > 0
          ? clamp01(gestureState.points[0].x / screenSize.width)
          : clamp01(startX / canvas.getBoundingClientRect().width);
      const y1 =
        screenSize.height > 0
          ? clamp01(gestureState.points[0].y / screenSize.height)
          : clamp01(startY / canvas.getBoundingClientRect().height);
      const x2 =
        screenSize.width > 0
          ? clamp01(coords.screenX / screenSize.width)
          : clamp01(coords.x / canvas.getBoundingClientRect().width);
      const y2 =
        screenSize.height > 0
          ? clamp01(coords.screenY / screenSize.height)
          : clamp01(coords.y / canvas.getBoundingClientRect().height);
      showSwipeFeedback(startX, startY, coords.x, coords.y);
      vscode.postMessage({
        type: 'swipe',
        x1,
        y1,
        x2,
        y2,
        duration: now - startTime,
      });
    }
  }

  // ジェスチャー状態をリセット
  gestureState = {
    isGesturing: false,
    startTime: 0,
    lastTimestamp: 0,
    points: [],
    path: [],
  };
});

canvas.addEventListener('mouseleave', () => {
  isDragging = false;
});

// Touch events for mobile/trackpad (mobiledeck-style)
canvas.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const coords = convertToScreenCoords(
        touch.clientX,
        touch.clientY,
        e.currentTarget
      );
      const now = Date.now();

      startX = coords.x;
      startY = coords.y;
      startTime = now;

      // Initialize gesture state (mobiledeck-style)
      // durationは累積時間（最初のポイントからの経過時間）として記録
      gestureState = {
        isGesturing: false,
        startTime: now,
        lastTimestamp: now,
        points: [{x: coords.screenX, y: coords.screenY, duration: 0}], // 最初のポイントは0ms
        path: [[coords.x, coords.y]],
      };

      isDragging = true;
      longPressTriggered = false;
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        const x =
          screenSize.width > 0
            ? clamp01(coords.screenX / screenSize.width)
            : clamp01(startX / canvas.getBoundingClientRect().width);
        const y =
          screenSize.height > 0
            ? clamp01(coords.screenY / screenSize.height)
            : clamp01(startY / canvas.getBoundingClientRect().height);
        vscode.postMessage({
          type: 'longPress',
          x,
          y,
          duration: LONG_PRESS_DURATION,
        });
        showTapFeedback(startX, startY);
      }, LONG_PRESS_DURATION);
    }
    e.preventDefault();
  },
  {passive: false}
);

canvas.addEventListener(
  'touchmove',
  (e) => {
    if (!isDragging || gestureState.points.length === 0) return;

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const coords = convertToScreenCoords(
        touch.clientX,
        touch.clientY,
        e.currentTarget
      );
      const now = Date.now();

      // mobiledeck: 100ms以上経過したらジェスチャーとして収集開始
      if (
        !gestureState.isGesturing &&
        now - gestureState.startTime > GESTURE_THRESHOLD_MS
      ) {
        gestureState.isGesturing = true;
      }

      // ジェスチャー中、または100ms以上経過している場合はポイントを収集
      if (
        gestureState.isGesturing ||
        now - gestureState.startTime > GESTURE_THRESHOLD_MS
      ) {
        // durationは累積時間（最初のポイントからの経過時間）として記録
        const duration = now - gestureState.startTime;
        const newPoint = {x: coords.screenX, y: coords.screenY, duration};
        gestureState.points.push(newPoint);
        gestureState.path.push([coords.x, coords.y]);
        gestureState.lastTimestamp = now;
        gestureState.isGesturing = true;
      }

      // ロングプレスタイマーをキャンセル
      const deltaX = coords.x - startX;
      const deltaY = coords.y - startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (distance > TAP_THRESHOLD && longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
    e.preventDefault();
  },
  {passive: false}
);

canvas.addEventListener(
  'touchend',
  (e) => {
    if (
      !isDragging ||
      e.changedTouches.length !== 1 ||
      gestureState.points.length === 0
    )
      return;
    isDragging = false;

    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    const touch = e.changedTouches[0];
    const coords = convertToScreenCoords(
      touch.clientX,
      touch.clientY,
      e.currentTarget
    );
    const now = Date.now();

    if (longPressTriggered) {
      // already handled
    } else if (gestureState.isGesturing) {
      // mobiledeck: ジェスチャーとして送信
      // durationは累積時間（最初のポイントからの経過時間）として記録
      const duration = now - gestureState.startTime;
      const finalPoints = [
        ...gestureState.points,
        {x: coords.screenX, y: coords.screenY, duration},
      ];

      // 正規化座標に変換（mobilecliは正規化座標を受け取る）
      const normalizedPoints = finalPoints.map((p) => ({
        x: screenSize.width > 0 ? clamp01(p.x / screenSize.width) : p.x,
        y: screenSize.height > 0 ? clamp01(p.y / screenSize.height) : p.y,
        duration: p.duration,
      }));

      vscode.postMessage({type: 'gesture', points: normalizedPoints});
      showSwipeFeedback(startX, startY, coords.x, coords.y);
    } else {
      // タップとして処理
      const deltaX = coords.x - startX;
      const deltaY = coords.y - startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance < TAP_THRESHOLD) {
        const x =
          screenSize.width > 0
            ? clamp01(coords.screenX / screenSize.width)
            : clamp01(coords.x / canvas.getBoundingClientRect().width);
        const y =
          screenSize.height > 0
            ? clamp01(coords.screenY / screenSize.height)
            : clamp01(coords.y / canvas.getBoundingClientRect().height);
        const now = Date.now();
        if (now - lastTapTime < DOUBLE_TAP_INTERVAL) {
          vscode.postMessage({type: 'doubleTap', x, y});
          lastTapTime = 0;
        } else {
          vscode.postMessage({type: 'tap', x, y});
          lastTapTime = now;
        }
        showTapFeedback(coords.x, coords.y);
      } else {
        // 距離が大きい場合はスワイプとして処理（後方互換性のため）
        const x1 =
          screenSize.width > 0
            ? clamp01(gestureState.points[0].x / screenSize.width)
            : clamp01(startX / canvas.getBoundingClientRect().width);
        const y1 =
          screenSize.height > 0
            ? clamp01(gestureState.points[0].y / screenSize.height)
            : clamp01(startY / canvas.getBoundingClientRect().height);
        const x2 =
          screenSize.width > 0
            ? clamp01(coords.screenX / screenSize.width)
            : clamp01(coords.x / canvas.getBoundingClientRect().width);
        const y2 =
          screenSize.height > 0
            ? clamp01(coords.screenY / screenSize.height)
            : clamp01(coords.y / canvas.getBoundingClientRect().height);
        showSwipeFeedback(startX, startY, coords.x, coords.y);
        vscode.postMessage({
          type: 'swipe',
          x1,
          y1,
          x2,
          y2,
          duration: now - startTime,
        });
      }
    }

    // ジェスチャー状態をリセット
    gestureState = {
      isGesturing: false,
      startTime: 0,
      lastTimestamp: 0,
      points: [],
      path: [],
    };

    e.preventDefault();
  },
  {passive: false}
);

// Keyboard input handling
document.addEventListener('keydown', (e) => {
  if (!canvas || canvas.style.display === 'none') return;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key))
    return;

  if (e.key === 'Backspace') {
    vscode.postMessage({type: 'keypress', key: 'delete', special: true});
    e.preventDefault();
    return;
  }

  if (e.key === 'Enter') {
    vscode.postMessage({type: 'keypress', key: 'return', special: true});
    e.preventDefault();
    return;
  }

  if (e.key === 'Escape') {
    vscode.postMessage({type: 'keypress', key: 'escape', special: true});
    e.preventDefault();
    return;
  }

  if (e.key.length === 1) {
    vscode.postMessage({type: 'keypress', key: e.key});
    e.preventDefault();
  }
});

platformSelect.addEventListener('change', () => {
  vscode.postMessage({
    type: 'platformChange',
    platform: platformSelect.value,
  });
});

deviceSelect.addEventListener('change', () => {
  vscode.postMessage({
    type: 'deviceChange',
    deviceId: deviceSelect.value,
  });
});

document.getElementById('btn-home').addEventListener('click', () => {
  vscode.postMessage({type: 'home'});
});

document.getElementById('btn-back').addEventListener('click', () => {
  vscode.postMessage({type: 'back'});
});

document.getElementById('btn-screenshot').addEventListener('click', () => {
  vscode.postMessage({type: 'saveScreenshot'});
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  vscode.postMessage({type: 'refreshDevices'});
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  vscode.postMessage({type: 'disconnect'});
});

if (overlayToggle) {
  overlayToggle.addEventListener('change', () => {
    vscode.postMessage({type: 'toggleOverlay', enabled: overlayToggle.checked});
  });
}

let frameQueue = []; // mobiledeck-style multi-frame queue
let currentBitmap = null;
let isRendering = false;
let lastRenderAt = 0;
let animationFrameId = null;

// Performance tracking
let totalFramesReceived = 0;
let totalFramesRendered = 0;
let totalFramesDropped = 0;
let lastStatsUpdate = performance.now();

const MAX_FRAME_QUEUE = 1; // 遅延を最小化：最新フレームのみ保持

// Adaptive frame rate adjustment
let targetFps = 15;
let currentDropRate = 0;
let lastFpsAdjustment = performance.now();
const FPS_ADJUSTMENT_INTERVAL = 5000; // Adjust every 5 seconds
const MAX_DROP_RATE = 0.15; // 15% max acceptable drop rate
const MIN_DROP_RATE = 0.05; // 5% target drop rate

// Connection health monitoring
let lastFrameTime = performance.now();
let connectionHealthy = true;
const CONNECTION_TIMEOUT = 3000; // 3 seconds without frames = unhealthy

// WebCodecs (H.264) pipeline groundwork
let decoder = null;
let decoderConfig = null;
let decodedQueue = 0;
let lastChunkTime = performance.now();

const maxDecodeQueue = 3;
let askedFallback = false;

function normalizeToUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data?.data && Array.isArray(data.data)) {
    return new Uint8Array(data.data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }
  return null;
}

async function renderFrame(bytes) {
  if (!bytes) return;
  const started = performance.now();
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

    // requestAnimationFrameをキャンセルして即座に描画（遅延を最小化）
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    // 即座に描画（遅延を最小化）
    if (currentBitmap && ctx) {
      ctx.drawImage(currentBitmap, 0, 0, canvas.width, canvas.height);

      const renderLatency = Math.round(performance.now() - started);
      const renderLatencyEl = document.getElementById('render-latency');
      if (renderLatencyEl) {
        renderLatencyEl.textContent = 'Render ' + renderLatency + ' ms';
      }
    }
  } catch (err) {
    console.error('renderFrame failed', err);
  }
}

function updateConnectionHealth() {
  const now = performance.now();
  const elapsed = now - lastFrameTime;
  const healthy = elapsed < CONNECTION_TIMEOUT;
  if (healthy !== connectionHealthy) {
    connectionHealthy = healthy;
    const healthEl = document.getElementById('health');
    if (healthEl) {
      healthEl.style.display = 'inline';
      healthEl.style.color = healthy ? '#4caf50' : '#f44336';
      healthEl.title = healthy ? 'Connection healthy' : 'No frames received';
    }
  }
}

function maybeAdjustFps() {
  const now = performance.now();
  if (now - lastFpsAdjustment < FPS_ADJUSTMENT_INTERVAL) return;

  const total = totalFramesReceived || 1;
  currentDropRate = (totalFramesReceived - totalFramesRendered) / total;

  if (currentDropRate > MAX_DROP_RATE && targetFps > 8) {
    targetFps = Math.max(8, targetFps - 2);
    vscode.postMessage({type: 'adjustFps', fps: targetFps});
  } else if (currentDropRate < MIN_DROP_RATE && targetFps < 30) {
    targetFps = Math.min(30, targetFps + 2);
    vscode.postMessage({type: 'adjustFps', fps: targetFps});
  }

  lastFpsAdjustment = now;
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
    totalFramesRendered++;
    isRendering = false;
    dequeueAndRender();
  });
}

function enqueueFrame(bytes) {
  if (!bytes) return;
  totalFramesReceived++;
  lastFrameTime = performance.now();
  updateConnectionHealth();

  // 遅延を最小化：キューをクリアして最新フレームのみ保持
  if (frameQueue.length >= MAX_FRAME_QUEUE) {
    // 古いフレームを全てドロップ
    while (frameQueue.length > 0) {
      frameQueue.shift();
      totalFramesDropped++;
    }
  }

  frameQueue.push(bytes);
  // 即座にレンダリング（遅延を最小化）
  dequeueAndRender();

  const now = performance.now();
  if (now - lastStatsUpdate > 1000) {
    document.getElementById('fps').textContent = `${targetFps} FPS`;
    document.getElementById('queue').textContent = `Q:${frameQueue.length}`;
    lastStatsUpdate = now;
  }

  maybeAdjustFps();
}

function handleH264Chunk(message) {
  if (!('VideoDecoder' in window) || !decoderConfig) {
    if (!askedFallback) {
      askedFallback = true;
      vscode.postMessage({
        type: 'fallback-jpeg',
        reason: 'WebCodecs unavailable or not configured',
      });
    }
    return;
  }

  const data = normalizeToUint8Array(message.data);
  if (!data) return;

  if (decodedQueue > maxDecodeQueue) {
    return;
  }

  lastChunkTime = performance.now();
  const chunk = new EncodedVideoChunk({
    type: message.isKeyframe ? 'key' : 'delta',
    timestamp: lastChunkTime * 1000,
    data,
  });

  decoder.decode(chunk);
  decodedQueue++;
}

function setupDecoder(config) {
  if (!('VideoDecoder' in window)) {
    vscode.postMessage({
      type: 'fallback-jpeg',
      reason: 'WebCodecs not supported',
    });
    return;
  }

  decoderConfig = {
    codec: config.codec || 'avc1.42E01E',
    description: normalizeToUint8Array(config.description) || undefined,
  };

  if (decoder) {
    decoder.close();
    decoder = null;
  }

  decoder = new VideoDecoder({
    output: (frame) => {
      const started = performance.now();
      const bitmap = frame;

      if (
        canvas.width !== bitmap.codedWidth ||
        canvas.height !== bitmap.codedHeight
      ) {
        canvas.width = bitmap.codedWidth;
        canvas.height = bitmap.codedHeight;
      }

      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = requestAnimationFrame(() => {
        try {
          const offscreen = new OffscreenCanvas(
            bitmap.codedWidth,
            bitmap.codedHeight
          );
          const ctx2 = offscreen.getContext('2d');
          ctx2.drawImage(bitmap, 0, 0);
          const imageBitmapPromise = offscreen.transferToImageBitmap
            ? Promise.resolve(offscreen.transferToImageBitmap())
            : createImageBitmap(offscreen);

          imageBitmapPromise.then((imgBitmap) => {
            if (currentBitmap) {
              currentBitmap.close?.();
              currentBitmap = null;
            }
            currentBitmap = imgBitmap;
            ctx.drawImage(imgBitmap, 0, 0, canvas.width, canvas.height);
            const renderLatency = Math.round(performance.now() - started);
            document.getElementById('render-latency').textContent =
              'Render ' + renderLatency + ' ms';
          });
        } finally {
          animationFrameId = null;
          decodedQueue = Math.max(0, decodedQueue - 1);
        }
      });
    },
    error: (err) => {
      console.error('VideoDecoder error', err);
      vscode.postMessage({
        type: 'fallback-jpeg',
        reason: err?.message || 'decoder error',
      });
    },
  });

  decoder.configure(decoderConfig);
}

function updateStatus(text) {
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function setOverlayVisible(visible, text = 'Select a device to start') {
  if (!overlay) return;
  overlay.classList.toggle('hidden', !visible);
  overlay.querySelector('span').textContent = text;
  canvas.style.display = visible ? 'none' : 'block';
}

window.addEventListener('message', (event) => {
  const message = event.data;

  // Handle screen size update (mobiledeck-style)
  if (message.type === 'screenSize' && message.width && message.height) {
    screenSize = {width: message.width, height: message.height};
    return;
  }

  switch (message.type) {
    case 'devices':
      deviceSelect.innerHTML = '<option value="">Select Device...</option>';
      message.devices.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = `${device.name} (${device.state})`;
        deviceSelect.appendChild(option);
      });
      break;

    case 'config':
      if (typeof message.tapThreshold === 'number') {
        TAP_THRESHOLD = message.tapThreshold;
      }
      if (typeof message.swipeThreshold === 'number') {
        SWIPE_THRESHOLD = message.swipeThreshold;
      }
      if (typeof message.showGestureOverlay === 'boolean') {
        SHOW_GESTURE_OVERLAY = message.showGestureOverlay;
        if (overlayToggle) {
          overlayToggle.checked = SHOW_GESTURE_OVERLAY;
        }
      }
      if (typeof message.longPressDuration === 'number') {
        LONG_PRESS_DURATION = message.longPressDuration;
      }
      break;

    case 'frame':
      enqueueFrame(normalizeToUint8Array(message.data));
      setOverlayVisible(false);
      break;

    case 'stats':
      document.getElementById('fps').textContent = `${message.fps} FPS`;
      document.getElementById('latency').textContent = `${message.latency} ms`;
      break;

    case 'status':
      updateStatus(message.text);
      break;

    case 'error':
      updateStatus('Error');
      setOverlayVisible(true, message.text);
      break;

    case 'disconnected':
      frameQueue = [];
      setOverlayVisible(true, 'Disconnected');
      break;

    case 'captureModeChanged':
      if (captureModeSelect) {
        captureModeSelect.value = message.mode;
      }
      break;

    case 'h264-config':
      setupDecoder(message);
      break;

    case 'h264-chunk':
      handleH264Chunk(message);
      break;
  }
});

window.addEventListener('resize', () => {
  if (!canvas || !currentBitmap) return;
  ctx.drawImage(currentBitmap, 0, 0, canvas.width, canvas.height);
});

vscode.postMessage({type: 'init'});
