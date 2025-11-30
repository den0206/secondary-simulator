const vscode = acquireVsCodeApi();
const canvas = document.getElementById('simulator-canvas');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const deviceSelect = document.getElementById('device');

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
let startClientX = 0; // ビューポート座標（フィードバック表示用）
let startClientY = 0; // ビューポート座標（フィードバック表示用）
let startTime = 0;
let lastTapTime = 0;
let longPressTimer = null;
let longPressTriggered = false;
let SWIPE_THRESHOLD = 30; // minimum pixels for swipe
let TAP_THRESHOLD = 10; // maximum pixels for tap
let LONG_PRESS_DURATION = 600;
const DOUBLE_TAP_INTERVAL = 300;
const GESTURE_THRESHOLD_MS = 100; // mobiledeck: 100ms以内はタップ、それ以上はジェスチャー

// Operation indicator
let operationIndicatorTimer = null;
const OPERATION_INDICATOR_DURATION = 2000; // 2秒間表示

function showOperationIndicator(operationType) {
  const indicator = document.getElementById('operation-indicator');
  if (!indicator) return;

  // 既存のタイマーをクリア
  if (operationIndicatorTimer) {
    clearTimeout(operationIndicatorTimer);
    operationIndicatorTimer = null;
  }

  // 操作の種類に応じたテキストを設定
  const operationTexts = {
    tap: 'Tap',
    doubleTap: 'Double Tap',
    swipe: 'Swipe',
    gesture: 'Gesture',
    longPress: 'Long Press',
    home: 'Home',
    back: 'Back',
  };

  indicator.textContent = operationTexts[operationType] || operationType;
  indicator.style.display = 'block';

  // 一定時間後に非表示
  operationIndicatorTimer = setTimeout(() => {
    indicator.style.display = 'none';
    operationIndicatorTimer = null;
  }, OPERATION_INDICATOR_DURATION);
}

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

canvas.addEventListener('mousedown', (e) => {
  isDragging = true;
  const coords = convertToScreenCoords(e.clientX, e.clientY, e.currentTarget);
  const now = Date.now();

  startX = coords.x;
  startY = coords.y;
  startClientX = e.clientX; // ビューポート座標を保存（フィードバック表示用）
  startClientY = e.clientY; // ビューポート座標を保存（フィードバック表示用）
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
    showOperationIndicator('longPress');
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
    showOperationIndicator('gesture');
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
        showOperationIndicator('doubleTap');
        lastTapTime = 0;
      } else {
        vscode.postMessage({type: 'tap', x, y});
        showOperationIndicator('tap');
        lastTapTime = now;
      }
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
      vscode.postMessage({
        type: 'swipe',
        x1,
        y1,
        x2,
        y2,
        duration: now - startTime,
      });
      showOperationIndicator('swipe');
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
      startClientX = touch.clientX; // ビューポート座標を保存（フィードバック表示用）
      startClientY = touch.clientY; // ビューポート座標を保存（フィードバック表示用）
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
        // ロングプレス時のフィードバックは、実際のイベント発生時に表示されるため、ここでは表示しない
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
      showOperationIndicator('gesture');
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
          showOperationIndicator('doubleTap');
          lastTapTime = 0;
        } else {
          vscode.postMessage({type: 'tap', x, y});
          showOperationIndicator('tap');
          lastTapTime = now;
        }
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
        vscode.postMessage({
          type: 'swipe',
          x1,
          y1,
          x2,
          y2,
          duration: now - startTime,
        });
        showOperationIndicator('swipe');
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

deviceSelect.addEventListener('change', () => {
  vscode.postMessage({
    type: 'deviceChange',
    deviceId: deviceSelect.value,
  });
});

document.getElementById('btn-home').addEventListener('click', () => {
  vscode.postMessage({type: 'home'});
  showOperationIndicator('home');
});

document.getElementById('btn-back').addEventListener('click', () => {
  vscode.postMessage({type: 'back'});
  showOperationIndicator('back');
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  vscode.postMessage({type: 'disconnect'});
});

let frameQueue = []; // mobiledeck-style multi-frame queue
let currentBitmap = null;
let isRendering = false;
let lastRenderAt = 0;
let animationFrameId = null;

// Performance tracking
let totalFramesReceived = 0;
let totalFramesRendered = 0;
let totalFramesDropped = 0;

const MAX_FRAME_QUEUE = 1; // 遅延を最小化：最新フレームのみ保持

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
    totalFramesRendered++;
    isRendering = false;
    dequeueAndRender();
  });
}

function enqueueFrame(bytes) {
  if (!bytes) return;
  totalFramesReceived++;

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
      if (typeof message.longPressDuration === 'number') {
        LONG_PRESS_DURATION = message.longPressDuration;
      }
      break;

    case 'frame':
      enqueueFrame(normalizeToUint8Array(message.data));
      setOverlayVisible(false);
      break;

    case 'error':
      setOverlayVisible(true, message.text);
      break;

    case 'disconnected':
      frameQueue = [];
      setOverlayVisible(true, 'Disconnected');
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
