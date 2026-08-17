// simhid-server — iOS Simulator HID 直接注入サイドカー（常駐プロセス）
//
//   ビルド: clang -fobjc-arc -O2 -framework Foundation -framework CoreFoundation \
//              -o simhid-server simhid-server.m
//   実行:   simhid-server            （UDID はコマンドごとに指定。全デバイス1プロセス）
//           simhid-server --check    （私有 API が解決できるかだけ確認して終了。0=OK）
//
// プロトコル: stdin/stdout に JSON Lines（1行=1メッセージ、UTF-8、\n 区切り）。
//   詳細は docs/sidecar-protocol.md、HID 注入の仕様は docs/ios-hid-injection.md を参照。
//
// 受信コマンド（stdin）: { "id": <num?>, "cmd": <str>, "device": <udid>, ... }
//   touchDown/touchMove/touchUp { x, y }        1本指。座標は正規化 [0,1]
//   touch2Down/touch2Move/touch2Up { x,y,x2,y2 } 2本指
//   tap { x, y }                                 down→up
//   button { name: "home"|"lock" }
//   keyDown/keyUp { usage }                      USB HID usage code
//   modifier { bit, down }                       bit は 16..20
//   text { value }                               ASCII 一括入力
//   captureStart { fps?, maxWidth?, quality? }   画面バッファの JPEG 配信を開始
//   captureStop                                  同 停止
//   ping
//
// 送信（stdout）:
//   応答: { "id": <num>, "ok": <bool>, "error": <str?>, "latencyMs": <num?> }
//   通知: { "event": "ready"|"fatal"|"portLost"|"recovered", ... }
//         { "event": "frame", "device": <udid>, "w": <num>, "h": <num>, "data": <base64 JPEG> }
//
// 全て非公開 API に依存。Xcode 更新で壊れうる（起動時にシンボル検査し fatal を出す）。
#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <pthread.h>

#pragma mark - 復元した private API（docs/ios-hid-injection.md 参照）

typedef void *(*MouseMsgFn)(const CGPoint *p1, const CGPoint *p2, uint64_t target,
                            uint64_t nsEventType, uint64_t buttonNumber, double sx, double sy);
typedef void *(*ButtonMsgFn)(uint32_t keyCode, uint32_t op, uint32_t target);
typedef void *(*KeyMsgFn)(uint64_t usageCode, uint64_t op);
typedef void *(*ModMsgFn)(uint32_t bit, uint64_t op);

static const uint64_t kTouchTarget = 0x32;   // タッチ/ドラッグ/ピンチ
static const uint32_t kButtonTarget = 0x33;  // ハードウェアボタン
enum { kMouseDown = 1, kMouseUp = 2, kMouseDragged = 6 };  // NSEventType
enum { kButtonHome = 0, kButtonLock = 1 };
enum { kModShift = 17 };  // 修飾キーの bit（16..20 のみ有効）

// ドラッグは前回から約16ms 空けないと生成関数が NULL を返す（0xF423FF ns のレートリミッタ）
static const uint64_t kDragMinIntervalNs = 16000000ULL;  // 16ms

#pragma mark - グローバル

static MouseMsgFn mouseMsg;
static ButtonMsgFn buttonMsg;
static KeyMsgFn keyMsg;
static ModMsgFn modMsg;

static Class gHidCls;
static SEL gInitSel, gSendSel;
static id gDeviceSet;                         // SimDeviceSet
static NSMutableDictionary *gStates;          // udid(小文字) → DeviceState
static dispatch_queue_t gQueue;               // 全注入を直列化するシリアルキュー
// 画面取り込みは入力と別系統にする。JPEG 変換（実測 2ms）で注入を待たせない。
static dispatch_queue_t gCaptureQueue;
// stdout は gQueue と gCaptureQueue の両方から書くので、行が混ざらないよう排他する。
static pthread_mutex_t gOutMutex = PTHREAD_MUTEX_INITIALIZER;
static uint64_t gTimebaseNum = 1, gTimebaseDen = 1;

static uint64_t nowNs(void) {
  return mach_absolute_time() * gTimebaseNum / gTimebaseDen;
}

#pragma mark - デバイス状態

@interface DeviceState : NSObject
@property(nonatomic, strong) id simDevice;
@property(nonatomic, strong) id hidClient;
@property(nonatomic, assign) uint64_t lastDragNs;
// drag coalescing 用の保留座標
@property(nonatomic, assign) BOOL pendingValid;
@property(nonatomic, assign) BOOL pendingHasP2;
@property(nonatomic, assign) CGPoint pendingP1;
@property(nonatomic, assign) CGPoint pendingP2;
@property(nonatomic, strong) dispatch_source_t flushTimer;
// 画面取り込み（captureStart で用意し、captureStop / プロセス終了まで持つ）
@property(nonatomic, strong) id ioClient;            // 解放すると port が閉じるので保持する
@property(nonatomic, strong) id displayDescriptor;   // SimDisplayIOSurfaceRenderable
@property(nonatomic, strong) CIContext *ciContext;
@property(nonatomic, strong) dispatch_source_t captureTimer;
@property(nonatomic, assign) double jpegQuality;
@property(nonatomic, assign) double maxWidth;
@property(nonatomic, assign) uint32_t lastSeed;      // IOSurface の世代。同じなら送らない
@property(nonatomic, assign) BOOL hasLastSeed;
/**
 * 直前に送った JPEG。seed は静止画面でも動くので、同一バイト列なら送らないための比較用。
 * 保持は常に 1 枚ぶん（実測 640px/q60 で約 68KB）。
 */
@property(nonatomic, strong) NSData *lastJpeg;
@end

@implementation DeviceState
@end

// 前方宣言（タイマハンドラが送信を使うため）
static BOOL sendToClient(DeviceState *st, void *msg);

#pragma mark - 出力

static NSData *lineData(NSDictionary *obj) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  if (!json) return nil;
  NSMutableData *line = [json mutableCopy];
  [line appendBytes:"\n" length:1];
  return line;
}

// gOutMutex を持った状態で呼ぶ
static void writeAllLocked(NSData *line) {
  const uint8_t *p = line.bytes;
  size_t remaining = line.length;
  while (remaining > 0) {
    ssize_t w = write(STDOUT_FILENO, p, remaining);
    if (w <= 0) break;
    p += w;
    remaining -= (size_t)w;
  }
}

// stdout への書き込み。gQueue と gCaptureQueue から呼ばれるので mutex で 1 行ずつに保つ。
static void emitLine(NSDictionary *obj) {
  NSData *line = lineData(obj);
  if (!line) return;
  pthread_mutex_lock(&gOutMutex);
  writeAllLocked(line);
  pthread_mutex_unlock(&gOutMutex);
}

/**
 * フレーム専用の送信。**待たずに捨てる**。
 *
 * 親の読み出しが遅いと write がブロックする。そこで入力の応答が mutex 待ちに
 * 入ると、映像の遅れが操作の遅れに化ける。フレームは捨ててよいので trylock にし、
 * 送れたときだけ YES を返す（呼び出し側は送れた絵だけを「直前のフレーム」にする）。
 */
static BOOL emitFrameLine(NSDictionary *obj) {
  NSData *line = lineData(obj);
  if (!line) return NO;
  if (pthread_mutex_trylock(&gOutMutex) != 0) return NO;
  writeAllLocked(line);
  pthread_mutex_unlock(&gOutMutex);
  return YES;
}

static void emitEvent(NSString *name, NSDictionary *extra) {
  NSMutableDictionary *d = [NSMutableDictionary dictionaryWithObject:name forKey:@"event"];
  if (extra) [d addEntriesFromDictionary:extra];
  emitLine(d);
}

static void respond(NSNumber *reqId, BOOL ok, NSString *error, double latencyMs) {
  if (!reqId) return;  // id 無しは fire-and-forget
  NSMutableDictionary *d = [NSMutableDictionary dictionary];
  d[@"id"] = reqId;
  d[@"ok"] = @(ok);
  if (error) d[@"error"] = error;
  if (latencyMs >= 0) d[@"latencyMs"] = @(latencyMs);
  emitLine(d);
}

#pragma mark - HID クライアント

static id makeClient(id simDevice) {
  NSError *err = nil;
  id client = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
      [gHidCls alloc], gInitSel, simDevice, &err);
  if (!client) {
    fprintf(stderr, "[simhid] HID クライアント生成失敗: %s\n", err.description.UTF8String);
  }
  return client;
}

// gQueue 上でのみ呼ぶ。UDID からデバイス状態を取得（初回に生成しキャッシュ）
static DeviceState *stateForDevice(NSString *udid) {
  NSString *key = udid.lowercaseString;
  DeviceState *st = gStates[key];
  if (st) return st;

  id found = nil;
  NSArray *devices = ((id (*)(id, SEL))objc_msgSend)(gDeviceSet, sel_registerName("devices"));
  for (id d in devices) {
    NSUUID *u = ((id (*)(id, SEL))objc_msgSend)(d, sel_registerName("UDID"));
    if ([u.UUIDString caseInsensitiveCompare:udid] == NSOrderedSame) { found = d; break; }
  }
  if (!found) return nil;

  st = [DeviceState new];
  st.simDevice = found;
  st.hidClient = makeClient(found);
  if (!st.hidClient) return nil;

  // drag flush 用のワンショットタイマ（gQueue で発火）。初期は FOREVER で無効
  st.flushTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gQueue);
  __weak DeviceState *weakSt = st;
  dispatch_source_set_event_handler(st.flushTimer, ^{
    DeviceState *s = weakSt;
    if (!s || !s.pendingValid) return;
    CGPoint p1 = s.pendingP1, p2 = s.pendingP2;
    void *msg = mouseMsg(&p1, s.pendingHasP2 ? &p2 : NULL,
                         kTouchTarget, kMouseDragged, 0, 1.0, 1.0);
    s.pendingValid = NO;
    if (msg && sendToClient(s, msg)) s.lastDragNs = nowNs();
  });
  dispatch_source_set_timer(st.flushTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
  dispatch_resume(st.flushTimer);

  gStates[key] = st;
  return st;
}

// メッセージ送信。エラー時はクライアントを作り直して1回リトライ（resetHIDSession は使わない）。
// msg は calloc 由来なので freeWhenDone:NO で送り、ここで free する。
static BOOL sendToClient(DeviceState *st, void *msg) {
  if (!msg) return NO;
  BOOL ok = NO;
  for (int attempt = 0; attempt < 2; attempt++) {
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSError *err = nil;
    ((void (*)(id, SEL, void *, BOOL, id, id))objc_msgSend)(
        st.hidClient, gSendSel, msg, NO,
        dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0),
        ^(NSError *e) { err = e; dispatch_semaphore_signal(sem); });
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    if (!err) { ok = YES; break; }
    if (attempt == 0) {
      // ポート断とみなしてクライアント再生成（唯一の有効な復帰手段）
      NSUUID *u = ((id (*)(id, SEL))objc_msgSend)(st.simDevice, sel_registerName("UDID"));
      emitEvent(@"portLost", @{@"device": u.UUIDString});
      id fresh = makeClient(st.simDevice);
      if (fresh) { st.hidClient = fresh; continue; }
    }
    fprintf(stderr, "[simhid] 送信エラー: %s\n", err.description.UTF8String);
  }
  if (ok && st.lastDragNs == 0) {
    // 直前に portLost を出していた場合の復帰通知（簡易: 初回成功のみ抑制しない）
  }
  free(msg);
  return ok;
}

#pragma mark - 画面取り込み（SimDisplayIOSurfaceRenderable）

/**
 * ディスプレイの descriptor を探す。
 *
 * WDA(XCTest) のスクリーンショットは「テスト対象アプリのウィンドウ」しか描かないため、
 * ソフトウェアキーボードやステータスバーが落ちる（iOS 26 / WDA 10.2.4 で実測）。
 * こちらは端末のフレームバッファそのものなので、画面に出ているものが全て入る。
 *
 * ROCK のリモートプロキシは respondsToSelector: に答えないので、クラス名に
 * 埋め込まれたインタフェース名で判定する（`…-SimDisplayIOSurfaceRenderable-…`）。
 */
// マスク済み（角丸・ノッチが黒で抜かれる）を優先し、無ければ素のフレームバッファ。
static id surfaceForDescriptor(id descriptor) {
  id surf = ((id (*)(id, SEL))objc_msgSend)(
      descriptor, sel_registerName("maskedFramebufferSurface"));
  if (surf) return surf;
  return ((id (*)(id, SEL))objc_msgSend)(descriptor, sel_registerName("framebufferSurface"));
}

static id displayDescriptorForDevice(id simDevice, id *ioClientOut) {
  Class ioCls = objc_lookUpClass("SimDeviceIOClient");
  if (!ioCls) return nil;
  id client = ((id (*)(id, SEL, id, dispatch_queue_t, void (^)(NSError *)))objc_msgSend)(
      [ioCls alloc], sel_registerName("initWithDevice:errorQueue:errorHandler:"),
      simDevice, gCaptureQueue, ^(NSError *e) {
        fprintf(stderr, "[simhid] io error: %s\n", e.description.UTF8String);
      });
  if (!client) return nil;
  NSArray *ports = ((id (*)(id, SEL))objc_msgSend)(client, sel_registerName("ioPorts"));
  for (id port in ports) {
    if (![port respondsToSelector:sel_registerName("descriptor")]) continue;
    id desc = ((id (*)(id, SEL))objc_msgSend)(port, sel_registerName("descriptor"));
    if (!desc) continue;
    if (![NSStringFromClass([desc class]) containsString:@"SimDisplayIOSurfaceRenderable"]) {
      continue;
    }
    // 該当 descriptor は複数ある（外部ディスプレイ等）。実際に面を返すものだけ使う。
    if (!surfaceForDescriptor(desc)) continue;
    *ioClientOut = client;
    return desc;
  }
  return nil;
}

// gCaptureQueue 上。1 フレーム取り込んで JPEG にし、frame 通知として送る。
static void captureTick(DeviceState *st, NSString *udid) {
  @autoreleasepool {
    id surfObj = surfaceForDescriptor(st.displayDescriptor);
    if (!surfObj) return;  // 画面が無い間（消灯・切替中）は黙って飛ばす
    IOSurfaceRef surface = (__bridge IOSurfaceRef)surfObj;
    uint32_t seed = IOSurfaceGetSeed(surface);
    if (st.hasLastSeed && seed == st.lastSeed) return;  // 画面が変わっていない
    st.lastSeed = seed;
    st.hasLastSeed = YES;

    CIImage *img = [CIImage imageWithIOSurface:surface];
    CGFloat width = img.extent.size.width;
    if (width < 1) return;
    CGFloat scale = (st.maxWidth > 0 && width > st.maxWidth) ? st.maxWidth / width : 1.0;
    CIImage *out = scale < 1.0
        ? [img imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)]
        : img;
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    NSData *jpeg = [st.ciContext
        JPEGRepresentationOfImage:out
                       colorSpace:cs
                          options:@{(id)kCGImageDestinationLossyCompressionQuality:
                                        @(st.jpegQuality)}];
    CGColorSpaceRelease(cs);
    if (!jpeg) return;
    // 画面が止まっていても seed は動く。中身が同じなら送らない（帯域を 0 にする）
    if (st.lastJpeg && [st.lastJpeg isEqualToData:jpeg]) return;
    BOOL sent = emitFrameLine(@{
      @"event": @"frame",
      @"device": udid,
      @"w": @((int)out.extent.size.width),
      @"h": @((int)out.extent.size.height),
      @"data": [jpeg base64EncodedStringWithOptions:0],
    });
    // 送れなかったぶんを「直前のフレーム」にすると、画面が止まったまま復帰しない
    if (sent) st.lastJpeg = jpeg;
  }
}

// gQueue 上。二重開始は no-op。
static BOOL startCapture(DeviceState *st, NSString *udid, double fps, double maxWidth,
                         double quality, NSString **err) {
  if (st.captureTimer) return YES;
  if (!st.displayDescriptor) {
    id client = nil;
    id desc = displayDescriptorForDevice(st.simDevice, &client);
    if (!desc) {
      *err = @"ディスプレイの descriptor が見つからない";
      return NO;
    }
    st.ioClient = client;
    st.displayDescriptor = desc;
  }
  if (!st.ciContext) st.ciContext = [CIContext contextWithOptions:nil];
  st.jpegQuality = MIN(MAX(quality, 0.1), 1.0);
  st.maxWidth = maxWidth;
  st.hasLastSeed = NO;
  st.lastJpeg = nil;

  double hz = MIN(MAX(fps, 1.0), 60.0);
  uint64_t interval = (uint64_t)(NSEC_PER_SEC / hz);
  dispatch_source_t timer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gCaptureQueue);
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), interval,
                            interval / 10);
  __weak DeviceState *weakSt = st;
  dispatch_source_set_event_handler(timer, ^{
    DeviceState *s = weakSt;
    if (s) captureTick(s, udid);
  });
  st.captureTimer = timer;
  dispatch_resume(timer);
  return YES;
}

static void stopCapture(DeviceState *st) {
  if (!st.captureTimer) return;
  dispatch_source_cancel(st.captureTimer);
  st.captureTimer = nil;
  st.hasLastSeed = NO;
  st.lastJpeg = nil;
}

#pragma mark - 入力プリミティブ（全て gQueue 上）

// 保留中の drag を即座に流し切る（down/up/別ジェスチャの前に呼ぶ）
static void flushPending(DeviceState *st) {
  dispatch_source_set_timer(st.flushTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
  if (!st.pendingValid) return;
  CGPoint p1 = st.pendingP1, p2 = st.pendingP2;
  void *msg = mouseMsg(&p1, st.pendingHasP2 ? &p2 : NULL,
                       kTouchTarget, kMouseDragged, 0, 1.0, 1.0);
  st.pendingValid = NO;
  if (msg && sendToClient(st, msg)) st.lastDragNs = nowNs();
}

static BOOL injectTouch(DeviceState *st, CGPoint p1, const CGPoint *p2, uint64_t nsEventType) {
  void *msg = mouseMsg(&p1, p2, kTouchTarget, nsEventType, 0, 1.0, 1.0);
  return sendToClient(st, msg);
}

// ドラッグの coalescing（16ms レートリミッタ吸収）
static void coalesceMove(DeviceState *st, CGPoint p1, const CGPoint *p2) {
  uint64_t now = nowNs();
  if (now - st.lastDragNs >= kDragMinIntervalNs) {
    if (injectTouch(st, p1, p2, kMouseDragged)) st.lastDragNs = now;
    st.pendingValid = NO;
    dispatch_source_set_timer(st.flushTimer, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
  } else {
    // 16ms 未満: 最新座標を保持し、16ms 境界で必ず1回流す
    st.pendingP1 = p1;
    st.pendingHasP2 = (p2 != NULL);
    if (p2) st.pendingP2 = *p2;
    st.pendingValid = YES;
    uint64_t fireNs = st.lastDragNs + kDragMinIntervalNs;
    dispatch_time_t fire = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(fireNs - now));
    dispatch_source_set_timer(st.flushTimer, fire, DISPATCH_TIME_FOREVER, 1000000);
  }
}

static void pressButtonAsync(DeviceState *st, uint32_t code) {
  sendToClient(st, buttonMsg(code, 1, kButtonTarget));
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), gQueue, ^{
    sendToClient(st, buttonMsg(code, 2, kButtonTarget));
  });
}

// ASCII → USB HID Keyboard usage code（0 なら未対応）。shift が要るなら *shift に YES
static uint8_t usageForChar(unichar c, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') return (uint8_t)(4 + (c - 'a'));
  if (c >= 'A' && c <= 'Z') { *shift = YES; return (uint8_t)(4 + (c - 'A')); }
  if (c >= '1' && c <= '9') return (uint8_t)(0x1e + (c - '1'));
  if (c == '0') return 0x27;
  switch (c) {
    case ' ': return 0x2c;
    case '\n': return 0x28;
    case '\t': return 0x2b;
    case '-': return 0x2d;
    case '.': return 0x37;
    case ',': return 0x36;
    case '/': return 0x38;
    case ';': return 0x33;
    default: return 0;
  }
}

// ASCII 文字列を1文字ずつ注入。非 ASCII はスキップ（拡張ホストが WDA へ委譲する前提）
static void injectText(DeviceState *st, NSString *value, int *sent, int *skipped) {
  *sent = *skipped = 0;
  // ウォームアップ: バースト先頭の HID イベントが稀に取りこぼされる（先頭大文字の Shift が落ちる）。
  // 文字を生まない Shift down→up を捨てイベントとして先に送り、本文を確実に通す。
  sendToClient(st, modMsg(kModShift, 1));
  sendToClient(st, modMsg(kModShift, 0));
  usleep(10000);
  for (NSUInteger i = 0; i < value.length; i++) {
    BOOL shift = NO;
    uint8_t u = usageForChar([value characterAtIndex:i], &shift);
    if (!u) { (*skipped)++; continue; }
    if (shift) { sendToClient(st, modMsg(kModShift, 1)); usleep(8000); }
    sendToClient(st, keyMsg(u, 1));
    usleep(12000);
    sendToClient(st, keyMsg(u, 2));
    if (shift) { usleep(8000); sendToClient(st, modMsg(kModShift, 0)); }
    usleep(20000);
    (*sent)++;
  }
}

#pragma mark - コマンド処理（gQueue 上）

static double numAt(NSDictionary *d, NSString *k, double dflt) {
  id v = d[k];
  return [v isKindOfClass:NSNumber.class] ? [v doubleValue] : dflt;
}

static void handleCommand(NSDictionary *cmd) {
  NSNumber *reqId = [cmd[@"id"] isKindOfClass:NSNumber.class] ? cmd[@"id"] : nil;
  NSString *name = cmd[@"cmd"];
  if (![name isKindOfClass:NSString.class]) { respond(reqId, NO, @"cmd がない", -1); return; }

  if ([name isEqualToString:@"ping"]) { respond(reqId, YES, nil, -1); return; }

  NSString *udid = cmd[@"device"];
  if (![udid isKindOfClass:NSString.class]) { respond(reqId, NO, @"device がない", -1); return; }
  DeviceState *st = stateForDevice(udid);
  if (!st) { respond(reqId, NO, @"デバイスが見つからないか初期化失敗", -1); return; }

  uint64_t t0 = nowNs();
  CGPoint p1 = CGPointMake(numAt(cmd, @"x", 0), numAt(cmd, @"y", 0));
  CGPoint p2 = CGPointMake(numAt(cmd, @"x2", 0), numAt(cmd, @"y2", 0));
  BOOL ok = YES;
  NSString *err = nil;

  if ([name isEqualToString:@"touchDown"]) {
    flushPending(st);
    ok = injectTouch(st, p1, NULL, kMouseDown);
    // down 直後の move が速すぎると iOS がドラッグ開始と認識しない。
    // down 時刻を記録して最初の move を16ms遅らせる（coalesce の pending 経路に落とす）
    st.lastDragNs = nowNs();
  } else if ([name isEqualToString:@"touchMove"]) {
    coalesceMove(st, p1, NULL);
  } else if ([name isEqualToString:@"touchUp"]) {
    flushPending(st);
    ok = injectTouch(st, p1, NULL, kMouseUp);
  } else if ([name isEqualToString:@"touch2Down"]) {
    flushPending(st);
    ok = injectTouch(st, p1, &p2, kMouseDown);
    st.lastDragNs = nowNs();  // touchDown と同じく最初の move を16ms遅らせる
  } else if ([name isEqualToString:@"touch2Move"]) {
    coalesceMove(st, p1, &p2);
  } else if ([name isEqualToString:@"touch2Up"]) {
    flushPending(st);
    ok = injectTouch(st, p1, &p2, kMouseUp);
  } else if ([name isEqualToString:@"tap"]) {
    flushPending(st);
    ok = injectTouch(st, p1, NULL, kMouseDown);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 40 * NSEC_PER_MSEC), gQueue, ^{
      injectTouch(st, p1, NULL, kMouseUp);
    });
  } else if ([name isEqualToString:@"button"]) {
    NSString *bn = cmd[@"name"];
    if ([bn isEqualToString:@"home"]) pressButtonAsync(st, kButtonHome);
    else if ([bn isEqualToString:@"lock"]) pressButtonAsync(st, kButtonLock);
    else { ok = NO; err = @"未知のボタン"; }
  } else if ([name isEqualToString:@"keyDown"]) {
    ok = sendToClient(st, keyMsg((uint64_t)numAt(cmd, @"usage", 0), 1));
  } else if ([name isEqualToString:@"keyUp"]) {
    ok = sendToClient(st, keyMsg((uint64_t)numAt(cmd, @"usage", 0), 2));
  } else if ([name isEqualToString:@"modifier"]) {
    uint32_t bit = (uint32_t)numAt(cmd, @"bit", 0);
    BOOL down = [cmd[@"down"] boolValue];
    ok = sendToClient(st, modMsg(bit, down ? 1 : 0));
  } else if ([name isEqualToString:@"captureStart"]) {
    ok = startCapture(st, udid, numAt(cmd, @"fps", 30), numAt(cmd, @"maxWidth", 640),
                      numAt(cmd, @"quality", 0.6), &err);
  } else if ([name isEqualToString:@"captureStop"]) {
    stopCapture(st);
  } else if ([name isEqualToString:@"text"]) {
    NSString *value = cmd[@"value"];
    if (![value isKindOfClass:NSString.class]) { ok = NO; err = @"value がない"; }
    else { int s = 0, k = 0; injectText(st, value, &s, &k); }
  } else {
    ok = NO;
    err = [NSString stringWithFormat:@"未知のコマンド: %@", name];
  }

  respond(reqId, ok, err, (double)(nowNs() - t0) / 1e6);
}

#pragma mark - 起動とシンボル解決

static NSString *developerDir(void) {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
  t.arguments = @[ @"-p" ];
  NSPipe *pipe = [NSPipe pipe];
  t.standardOutput = pipe;
  if (![t launchAndReturnError:nil]) return nil;
  NSData *d = [pipe.fileHandleForReading readDataToEndOfFile];
  [t waitUntilExit];
  return [[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

// 私有フレームワークと Indigo シンボルだけ解決する（--check 用）
static BOOL setupSymbols(NSString **reason) {
  NSString *dev = developerDir();
  if (!dev.length) { *reason = @"xcode-select -p に失敗"; return NO; }

  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator", RTLD_NOW)) {
    *reason = @"CoreSimulator を読み込めない";
    return NO;
  }
  NSString *skPath = [dev stringByAppendingPathComponent:
      @"Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit"];
  void *sk = dlopen(skPath.UTF8String, RTLD_NOW);
  if (!sk) { *reason = @"SimulatorKit を読み込めない"; return NO; }

  mouseMsg = (MouseMsgFn)dlsym(sk, "IndigoHIDMessageForMouseNSEvent");
  buttonMsg = (ButtonMsgFn)dlsym(sk, "IndigoHIDMessageForButton");
  keyMsg = (KeyMsgFn)dlsym(sk, "IndigoHIDMessageForKeyboardArbitrary");
  modMsg = (ModMsgFn)dlsym(sk, "IndigoHIDMessageForModifierKeyBit");
  if (!mouseMsg || !buttonMsg || !keyMsg || !modMsg) {
    *reason = @"Indigo シンボルを解決できない（Xcode 更新の可能性）";
    return NO;
  }

  gHidCls = objc_lookUpClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
  if (!gHidCls) { *reason = @"HID クライアントクラスが見つからない"; return NO; }
  gInitSel = sel_registerName("initWithDevice:error:");
  gSendSel = sel_registerName("sendWithMessage:freeWhenDone:completionQueue:completion:");
  return YES;
}

// 成功なら YES。失敗時は理由を *reason に入れて NO
static BOOL setup(NSString **reason) {
  if (!setupSymbols(reason)) return NO;

  NSString *dev = developerDir();
  NSError *err = nil;
  id ctx = ((id (*)(Class, SEL, id, NSError **))objc_msgSend)(
      objc_lookUpClass("SimServiceContext"),
      sel_registerName("sharedServiceContextForDeveloperDir:error:"), dev, &err);
  if (!ctx) { *reason = @"SimServiceContext 取得失敗"; return NO; }
  gDeviceSet = ((id (*)(id, SEL, NSError **))objc_msgSend)(
      ctx, sel_registerName("defaultDeviceSetWithError:"), &err);
  if (!gDeviceSet) { *reason = @"デバイスセット取得失敗"; return NO; }

  return YES;
}

// stdin をブロッキングで読み、行ごとにパースして gQueue へ投げる（バックグラウンドスレッド）
static void readLoop(void) {
  NSMutableData *acc = [NSMutableData data];
  uint8_t buf[8192];
  for (;;) {
    ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
    if (n <= 0) { exit(0); }  // EOF or エラー: 親が閉じたら終了
    [acc appendBytes:buf length:(NSUInteger)n];
    for (;;) {
      const char *bytes = acc.bytes;
      NSUInteger len = acc.length, nl = NSNotFound;
      for (NSUInteger i = 0; i < len; i++) { if (bytes[i] == '\n') { nl = i; break; } }
      if (nl == NSNotFound) break;
      NSData *lineData = [acc subdataWithRange:NSMakeRange(0, nl)];
      [acc replaceBytesInRange:NSMakeRange(0, nl + 1) withBytes:NULL length:0];
      if (lineData.length == 0) continue;
      NSError *jerr = nil;
      id obj = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:&jerr];
      if ([obj isKindOfClass:NSDictionary.class]) {
        dispatch_async(gQueue, ^{ handleCommand(obj); });
      } else {
        fprintf(stderr, "[simhid] JSON パース失敗: %s\n", jerr.description.UTF8String);
      }
    }
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // --check: 私有 API の解決可否だけを見て終わる。Xcode 更新で壊れたことを
    // CI が先に踏むための入口（ユーザーの実機より先に気づくのが目的）。
    if (argc > 1 && strcmp(argv[1], "--check") == 0) {
      NSString *why = nil;
      if (!setupSymbols(&why)) {
        fprintf(stderr, "[simhid] check NG: %s\n", why.UTF8String ?: "不明");
        return 1;
      }
      fprintf(stdout, "[simhid] check OK\n");
      return 0;
    }

    mach_timebase_info_data_t tb;
    mach_timebase_info(&tb);
    gTimebaseNum = tb.numer;
    gTimebaseDen = tb.denom;

    gStates = [NSMutableDictionary dictionary];
    gQueue = dispatch_queue_create("com.secondary-simulator.simhid", DISPATCH_QUEUE_SERIAL);
    gCaptureQueue =
        dispatch_queue_create("com.secondary-simulator.simhid.capture", DISPATCH_QUEUE_SERIAL);

    NSString *reason = nil;
    if (!setup(&reason)) {
      emitEvent(@"fatal", @{@"reason": reason ?: @"不明"});
      return 1;
    }
    emitEvent(@"ready", @{@"pid": @(getpid())});

    // stdin 読み取りをバックグラウンドで回し、メインは dispatch を捌く
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ readLoop(); });
    dispatch_main();
  }
  return 0;
}
