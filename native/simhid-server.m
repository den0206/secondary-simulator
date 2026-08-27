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
//   captureStart { fps?, maxWidth?, quality?, sink?, mode? }
//                                                画面バッファの JPEG 配信を開始
//                                                sink: "stdout"(既定) | "http"
//                                                mode: "auto"(既定・変更通知) | "poll"
//   captureConfig { fps?, maxWidth?, quality? }  配信中の設定を張り直さずに変える
//   captureStop                                  同 停止
//   captureServe { enable, port?, token? }       フレームの HTTP 配信（device 不要）
//   ping
//
// 送信（stdout）:
//   応答: { "id": <num>, "ok": <bool>, "error": <str?>, "latencyMs": <num?> }
//   通知: { "event": "ready"|"fatal"|"portLost"|"recovered", ... }
//         { "event": "frame", "device": <udid>, "w": <num>, "h": <num>, "data": <base64 JPEG> }
//         { "event": "captureAlive", "device": <udid>, "ticks": <num>, "frames": <num>,
//           "noSurface": <num> }  取り込みが生きている合図（約2秒毎）
//
// 全て非公開 API に依存。Xcode 更新で壊れうる（起動時にシンボル検査し fatal を出す）。
#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <arpa/inet.h>
#import <dlfcn.h>
#import <errno.h>
#import <mach/mach_time.h>
#import <netinet/in.h>
#import <netinet/tcp.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <pthread.h>
#import <signal.h>
#import <string.h>
#import <sys/socket.h>
#import <time.h>
#import <unistd.h>

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
/** 設定された上限 fps。ポーリング間隔とプッシュ時のレート制限に使う。 */
@property(nonatomic, assign) double fps;
@property(nonatomic, assign) uint32_t lastSeed;      // IOSurface の世代。同じなら送らない
@property(nonatomic, assign) BOOL hasLastSeed;
/**
 * 直前に送った JPEG。seed は静止画面でも動くので、同一バイト列なら送らないための比較用。
 * 保持は常に 1 枚ぶん（実測 640px/q60 で約 68KB）。
 */
@property(nonatomic, strong) NSData *lastJpeg;
/**
 * 生存通知（captureAlive）用のカウンタ。
 *
 * **静止画面では frame が 1 枚も出ない**ので、親は「画面が動いていない」のか
 * 「取り込みが死んだ」のかを frame の有無だけでは区別できない。約2秒毎に
 * これを送り、親が停止検出を張れるようにする（docs/sidecar-protocol.md §3.5）。
 */
@property(nonatomic, assign) uint64_t lastAliveNs;
@property(nonatomic, assign) uint32_t tickCount;
@property(nonatomic, assign) uint32_t frameCount;
/** 連続して面が取れなかった tick 数。続くと descriptor を取り直す。 */
@property(nonatomic, assign) uint32_t noSurfaceTicks;

// ---- フレームの配信先（docs/sidecar-protocol.md §3.6）----
/**
 * `stdout`（JSON Lines の base64）か `http`（loopback の multipart）か。
 * http のときフレームは stdout を通らないので、**映像の背圧が入力の応答を
 * 巻き込まない**（§2.4）。
 */
@property(nonatomic, assign) BOOL sinkHttp;
/**
 * HTTP クライアントへ渡す最新の JPEG と、その世代。
 * **gFrameMutex を持っている間だけ触る**（取り込みキューと接続ごとのスレッドが共有する）。
 */
@property(nonatomic, strong) NSData *httpFrame;
@property(nonatomic, assign) uint64_t httpFrameGen;

// ---- プッシュ型の取り込み（docs/sidecar-protocol.md §3.7）----
/** 変更通知が使えているか。登録に失敗したら NO のままポーリングで回す。 */
@property(nonatomic, assign) BOOL pushMode;
@property(nonatomic, strong) NSUUID *pushUUID;
@property(nonatomic, assign) uint64_t lastPushNs;
@property(nonatomic, assign) uint64_t minPushIntervalNs;
/** レート制限で送らなかった変更が残っているか。境界で 1 回流す。 */
@property(nonatomic, assign) BOOL pushPending;
@property(nonatomic, assign) BOOL pushScheduled;
/** 変更通知が来ないのに画面が変わっていた回数。続くとポーリングへ戻す。 */
@property(nonatomic, assign) uint32_t pushMissed;
/** 直近にフレームを出した時刻。プッシュ型の自己点検に使う。 */
@property(nonatomic, assign) uint64_t lastFrameNs;
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

#pragma mark - フレームの HTTP 直結配信（docs/sidecar-protocol.md §3.6）

/**
 * webview の `<img>` へ multipart/x-mixed-replace を直接返す loopback サーバ。
 *
 * **なぜ stdout ではなく HTTP か。** stdout は入力の応答と共用で、しかも
 * ブロッキングな fd なので、親の読み出しが遅れるとフレームの write が
 * mutex を握ったまま止まり、入力の応答まで巻き込む（§2.4）。フレームを
 * 別経路にすると、この結合が設計から消える。あわせて base64 と JSON と
 * postMessage が丸ごと不要になり、multipart の復号は Chromium がやる。
 *
 * **安全側の決めごと**
 * - 127.0.0.1 でだけ待ち受ける（外部からは届かない）
 * - 起動毎のトークンを URL に要求する。合わないものは 404 で落とす
 *   （UDID は `xcrun simctl list` で誰でも読めるので、秘密にならない）
 * - ポートとトークンは**親が決めて渡す**。CSP は範囲で許可されているため、
 *   親が空きを探して順に試すのが一番単純（MjpegProxy と同じ形）
 */

static int gServeSocket = -1;
static NSString *gServeToken = nil;
/** 停止・再開を跨いで生き残ったスレッドを止めるための世代。 */
static uint64_t gServeEpoch = 0;
// httpFrame / httpFrameGen / gServeEpoch を守る。条件変数で新しいフレームを配る。
static pthread_mutex_t gFrameMutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gFrameCond = PTHREAD_COND_INITIALIZER;

static const char *kBoundary = "simhidframe";
/** 接続スレッドが停止指示を確認しに起きる間隔（静止画面では書くものが無いため）。 */
static const long kClientWaitSec = 2;
/**
 * 同時接続の上限。webview の `<img>` は 1 本しか張らないので、これで十分足りる。
 * 上限が無いと、同じマシンの任意プロセスが接続を積むだけでスレッドを使い切れる
 * （トークンが無いと絵は取れないが、スレッドは掴める）。
 */
static const int kMaxClients = 8;
/** ヘッダを読み切るまでの上限。無いと何も送らない接続がスレッドを占有し続ける。 */
static const int kHeaderTimeoutSec = 5;
static int gClientCount = 0;  // gFrameMutex で守る

/** 最新フレームを差し替えて待っている接続を起こす。取り込み側は**待たない**。 */
static void publishFrame(DeviceState *st, NSData *jpeg) {
  pthread_mutex_lock(&gFrameMutex);
  st.httpFrame = jpeg;
  st.httpFrameGen++;
  pthread_cond_broadcast(&gFrameCond);
  pthread_mutex_unlock(&gFrameMutex);
}

/** 長さが同じで内容も同じか。早期 return しない（トークンの推測を助けない）。 */
static BOOL tokenEquals(const char *given, size_t givenLen, NSString *expected) {
  if (!expected) return NO;
  const char *exp = expected.UTF8String;
  size_t expLen = strlen(exp);
  if (givenLen != expLen) return NO;
  unsigned char diff = 0;
  for (size_t i = 0; i < expLen; i++) diff |= (unsigned char)(given[i] ^ exp[i]);
  return diff == 0;
}

static BOOL writeAllFd(int fd, const void *bytes, size_t len) {
  const uint8_t *p = bytes;
  while (len > 0) {
    ssize_t w = write(fd, p, len);
    if (w <= 0) {
      if (w < 0 && errno == EINTR) continue;
      return NO;
    }
    p += w;
    len -= (size_t)w;
  }
  return YES;
}

/** クエリ文字列から key の値を取り出す（malloc せず範囲を返す）。 */
static const char *queryValue(const char *query, const char *key, size_t *outLen) {
  size_t keyLen = strlen(key);
  const char *p = query;
  while (p && *p) {
    const char *amp = strchr(p, '&');
    size_t segLen = amp ? (size_t)(amp - p) : strlen(p);
    if (segLen > keyLen + 1 && strncmp(p, key, keyLen) == 0 && p[keyLen] == '=') {
      *outLen = segLen - keyLen - 1;
      return p + keyLen + 1;
    }
    p = amp ? amp + 1 : NULL;
  }
  *outLen = 0;
  return NULL;
}

/** 相手が接続を閉じたか（読めるものが無いだけなら NO）。 */
static BOOL peerClosed(int fd) {
  char probe;
  ssize_t n = recv(fd, &probe, 1, MSG_PEEK | MSG_DONTWAIT);
  if (n == 0) return YES;                       // FIN を受けている
  if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return NO;
  return n < 0;                                 // それ以外のエラーも畳む
}

/** 接続枠を返す。clientThread の出口で必ず 1 回だけ呼ぶ。 */
static void releaseClientSlot(void) {
  pthread_mutex_lock(&gFrameMutex);
  if (gClientCount > 0) gClientCount--;
  pthread_mutex_unlock(&gFrameMutex);
}

typedef struct {
  int fd;
  uint64_t epoch;
} ClientArg;

static void *clientThread(void *arg) {
  ClientArg *carg = (ClientArg *)arg;
  int fd = carg->fd;
  uint64_t epoch = carg->epoch;
  free(carg);

  @autoreleasepool {
    // 読み取りに上限を設ける（何も送らない相手にスレッドを握らせない）
    struct timeval tv = {.tv_sec = kHeaderTimeoutSec, .tv_usec = 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    // ---- リクエストを読む（ヘッダ終端まで。上限付き）----
    char req[4096];
    size_t used = 0;
    BOOL complete = NO;
    while (used < sizeof(req) - 1) {
      ssize_t n = read(fd, req + used, sizeof(req) - 1 - used);
      if (n <= 0) break;
      used += (size_t)n;
      req[used] = '\0';
      if (strstr(req, "\r\n\r\n")) { complete = YES; break; }
    }
    if (!complete) { close(fd); releaseClientSlot(); return NULL; }

    // ---- "GET /stream?device=…&t=… HTTP/1.1" を分解する ----
    static const char *kNotFound =
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    if (strncmp(req, "GET /stream?", 12) != 0) {
      writeAllFd(fd, kNotFound, strlen(kNotFound));
      close(fd);
      releaseClientSlot();
      return NULL;
    }
    char *query = req + 12;
    char *sp = strchr(query, ' ');
    if (!sp) { close(fd); releaseClientSlot(); return NULL; }
    *sp = '\0';

    size_t tokLen = 0, devLen = 0;
    const char *tok = queryValue(query, "t", &tokLen);
    const char *dev = queryValue(query, "device", &devLen);
    // gServeToken は停止時に nil になる。ARC の解放と読みが競らないよう写しを取る
    pthread_mutex_lock(&gFrameMutex);
    NSString *expected = gServeToken;
    pthread_mutex_unlock(&gFrameMutex);
    // 経路とトークンが揃わないものは、存在自体を伏せて 404 で落とす
    if (!tok || !dev || !tokenEquals(tok, tokLen, expected)) {
      writeAllFd(fd, kNotFound, strlen(kNotFound));
      close(fd);
      releaseClientSlot();
      return NULL;
    }
    NSString *udid = [[NSString alloc] initWithBytes:dev
                                              length:devLen
                                            encoding:NSUTF8StringEncoding];
    __block DeviceState *st = nil;
    if (udid) {
      // gStates は gQueue の持ち物。取り出しだけ同期する
      NSString *key = udid.lowercaseString;
      dispatch_sync(gQueue, ^{ st = gStates[key]; });
    }
    if (!st) {
      writeAllFd(fd, kNotFound, strlen(kNotFound));
      close(fd);
      releaseClientSlot();
      return NULL;
    }

    // ---- multipart を流し始める ----
    char header[512];
    int headerLen = snprintf(header, sizeof(header),
                             "HTTP/1.1 200 OK\r\n"
                             "Content-Type: multipart/x-mixed-replace; boundary=%s\r\n"
                             "Cache-Control: no-cache, private\r\n"
                             "Pragma: no-cache\r\n"
                             "Connection: close\r\n\r\n",
                             kBoundary);
    if (!writeAllFd(fd, header, (size_t)headerLen)) {
      close(fd);
      releaseClientSlot();
      return NULL;
    }

    uint64_t seen = 0;
    for (;;) {
      NSData *frame = nil;
      pthread_mutex_lock(&gFrameMutex);
      if (st.httpFrameGen == seen && gServeEpoch == epoch) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_sec += kClientWaitSec;
        pthread_cond_timedwait(&gFrameCond, &gFrameMutex, &ts);
      }
      if (gServeEpoch != epoch) { pthread_mutex_unlock(&gFrameMutex); break; }
      if (st.httpFrameGen == seen) {
        pthread_mutex_unlock(&gFrameMutex);
        // 画面が静止していると書くものが無く、相手が消えたことに気づけない。
        // 待ちが空振りしたときだけ覗いて、閉じられていたらスレッドを畳む。
        if (peerClosed(fd)) break;
        continue;
      }
      // ARC が retain するので、ロックの外へ持ち出して書いてよい
      frame = st.httpFrame;
      seen = st.httpFrameGen;
      pthread_mutex_unlock(&gFrameMutex);
      if (!frame.length) continue;

      @autoreleasepool {
        char part[256];
        int partLen = snprintf(part, sizeof(part),
                               "--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %zu\r\n\r\n",
                               kBoundary, (size_t)frame.length);
        if (!writeAllFd(fd, part, (size_t)partLen)) break;
        if (!writeAllFd(fd, frame.bytes, frame.length)) break;
        if (!writeAllFd(fd, "\r\n", 2)) break;
      }
    }
    close(fd);
    releaseClientSlot();
  }
  return NULL;
}

static void *acceptThread(void *arg) {
  uint64_t epoch = (uint64_t)(uintptr_t)arg;
  for (;;) {
    int listenFd = gServeSocket;
    if (listenFd < 0 || gServeEpoch != epoch) break;
    int fd = accept(listenFd, NULL, NULL);
    if (fd < 0) {
      if (errno == EINTR) continue;
      break;  // ソケットが閉じられた
    }
    if (gServeEpoch != epoch) { close(fd); break; }
    // 接続が閉じたあとの write で落ちない（SIGPIPE は main でも無視している）
    int on = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));

    // 上限を超える接続は即座に閉じる（スレッドを作らない）
    pthread_mutex_lock(&gFrameMutex);
    BOOL tooMany = gClientCount >= kMaxClients;
    if (!tooMany) gClientCount++;
    pthread_mutex_unlock(&gFrameMutex);
    if (tooMany) { close(fd); continue; }

    ClientArg *carg = calloc(1, sizeof(ClientArg));
    if (!carg) { releaseClientSlot(); close(fd); continue; }
    carg->fd = fd;
    carg->epoch = epoch;
    pthread_t tid;
    if (pthread_create(&tid, NULL, clientThread, carg) != 0) {
      free(carg);
      releaseClientSlot();
      close(fd);
      continue;
    }
    pthread_detach(tid);
  }
  return NULL;
}

/** 待ち受けを止める。接続中のスレッドは世代が変わったことで抜ける。 */
static void stopServe(void) {
  pthread_mutex_lock(&gFrameMutex);
  gServeEpoch++;
  pthread_cond_broadcast(&gFrameCond);
  pthread_mutex_unlock(&gFrameMutex);
  int fd = gServeSocket;
  gServeSocket = -1;
  if (fd >= 0) {
    shutdown(fd, SHUT_RDWR);
    close(fd);
  }
  pthread_mutex_lock(&gFrameMutex);
  gServeToken = nil;
  pthread_mutex_unlock(&gFrameMutex);
}

/** 指定ポートで待ち受ける。埋まっていれば NO（親が次のポートを試す）。 */
static BOOL startServe(int port, NSString *token, NSString **err) {
  stopServe();
  if (port <= 0 || port > 65535 || token.length == 0) {
    *err = @"ポートかトークンが不正";
    return NO;
  }
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { *err = @"socket を作れない"; return NO; }
  int on = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  // 127.0.0.1 限定。0.0.0.0 にすると同じネットワークの誰でも画面を覗ける
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close(fd);
    *err = @"ポートが使えない";
    return NO;
  }
  if (listen(fd, 4) != 0) {
    close(fd);
    *err = @"listen に失敗";
    return NO;
  }

  gServeSocket = fd;
  pthread_mutex_lock(&gFrameMutex);
  gServeToken = [token copy];
  uint64_t epoch = ++gServeEpoch;
  pthread_mutex_unlock(&gFrameMutex);

  pthread_t tid;
  if (pthread_create(&tid, NULL, acceptThread, (void *)(uintptr_t)epoch) != 0) {
    stopServe();
    *err = @"accept スレッドを作れない";
    return NO;
  }
  pthread_detach(tid);
  fprintf(stderr, "[simhid] フレーム配信を開始: 127.0.0.1:%d\n", port);
  return YES;
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

// 約2秒毎の生存通知。取れなくても（trylock 失敗）次の機会に送る。
static const uint64_t kAliveIntervalNs = 2000000000ULL;  // 2s
// 面が取れないまま何 tick 続いたら descriptor を取り直すか（約2秒相当を上限とする）
static const uint32_t kReacquireAfterTicks = 60;
/**
 * プッシュ型のときのタイマ間隔。フレームは変更通知が運ぶので、
 * ここは生存通知と descriptor の取り直しのためだけに回る。
 */
static const uint64_t kPushTickIntervalNs = 500000000ULL;  // 500ms
/** 変更通知が来ないのに絵が変わっていた回数の許容。超えたらポーリングへ戻す。 */
static const uint32_t kPushMissTolerance = 2;
/**
 * プッシュ型で「しばらくフレームが出ていない」とみなす時間。
 * これを超えたときだけ自己点検で 1 枚撮る（＝静止中は毎秒 2 枚が上限のコスト）。
 */
static const uint64_t kPushProbeIdleNs = 1000000000ULL;  // 1s
/** 変更通知を使うか（captureStart の mode で決まる。既定は使う）。 */
static BOOL gPushEnabled = YES;

static void captureFrame(DeviceState *st, NSString *udid);
static BOOL registerPush(DeviceState *st, NSString *udid);
static void unregisterPush(DeviceState *st);
static void applyCaptureTimerInterval(DeviceState *st);

static void emitAlive(DeviceState *st, NSString *udid) {
  if (emitFrameLine(@{
        @"event": @"captureAlive",
        @"device": udid,
        @"ticks": @(st.tickCount),
        @"frames": @(st.frameCount),
        @"noSurface": @(st.noSurfaceTicks),
      })) {
    st.tickCount = 0;
    st.frameCount = 0;
  }
  // 送れなくても時刻は進める。詰まっている間に通知だけ溜め込まない
  st.lastAliveNs = nowNs();
}

/**
 * gCaptureQueue 上。1 枚取り込んで JPEG にし、配信先へ渡す。
 *
 * 呼び出し元は 2 つある。
 * - ポーリング（`captureTick`）: fps のタイマから
 * - プッシュ（`onDamage`）: ディスプレイの変更通知から（§3.1）
 *
 * 面が取れなかったときの取り直しと生存通知は `captureTick` の責務にしてある
 * （変更通知は「画面が変わったとき」しか来ないので、死活の判定には使えない）。
 */
static void captureFrame(DeviceState *st, NSString *udid) {
  @autoreleasepool {
    id surfObj = surfaceForDescriptor(st.displayDescriptor);
    if (!surfObj) return;  // 取り直しは captureTick が見る
    st.noSurfaceTicks = 0;
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

    if (st.sinkHttp) {
      // HTTP 直結。差し替えるだけで、接続の書き込みは待たない
      publishFrame(st, jpeg);
      st.lastJpeg = jpeg;
      st.frameCount++;
      st.lastFrameNs = nowNs();
      return;
    }
    BOOL sent = emitFrameLine(@{
      @"event": @"frame",
      @"device": udid,
      @"w": @((int)out.extent.size.width),
      @"h": @((int)out.extent.size.height),
      @"data": [jpeg base64EncodedStringWithOptions:0],
    });
    // 送れなかったぶんを「直前のフレーム」にすると、画面が止まったまま復帰しない
    if (sent) {
      st.lastJpeg = jpeg;
      st.frameCount++;
      st.lastFrameNs = nowNs();
    }
  }
}

/**
 * gCaptureQueue 上。生存通知・descriptor の取り直し・（ポーリング時は）取り込み。
 *
 * プッシュ型のときも**このタイマは止めない**。変更通知は画面が変わったときしか
 * 来ないので、生存通知と取り直しの担い手が要る。そのぶん間隔は寝かせてある。
 */
static void captureTick(DeviceState *st, NSString *udid) {
  @autoreleasepool {
    st.tickCount++;
    if (nowNs() - st.lastAliveNs >= kAliveIntervalNs) emitAlive(st, udid);

    id surfObj = surfaceForDescriptor(st.displayDescriptor);
    if (!surfObj) {
      // 画面が無い間（消灯・切替中）は黙って飛ばす。ただし**戻ってこない**場合がある
      // ―― シミュレータを再起動すると descriptor が古くなり、以後ずっと nil を返す。
      // 一定回数続いたら取り直す（docs/sidecar-protocol.md §3.5）。
      if (++st.noSurfaceTicks < kReacquireAfterTicks) return;
      st.noSurfaceTicks = 0;
      id client = nil;
      id desc = displayDescriptorForDevice(st.simDevice, &client);
      if (!desc) return;  // まだ駄目。次の周期でまた試す
      fprintf(stderr, "[simhid] display descriptor を取り直した\n");
      unregisterPush(st);
      st.ioClient = client;  // 旧 client は ARC が解放する（port も閉じる）
      st.displayDescriptor = desc;
      st.hasLastSeed = NO;
      st.lastJpeg = nil;
      registerPush(st, udid);  // 取り直した面へ張り直す（失敗したらポーリングのまま）
      return;
    }
    st.noSurfaceTicks = 0;

    if (!st.pushMode) {
      captureFrame(st, udid);
      return;
    }

    // ---- プッシュ型の自己点検 ----
    // 通知が来ないまま絵が変わっていたら、通知が機能していない。黙って固まるより
    // ポーリングへ戻したほうがよい（§3.1 の注意点）。
    //
    // **seed では判定できない。** IOSurfaceGetSeed は中身が同じでも動くので、
    // 静止画面でも「変わった」に見えてしまう（この誤検知を避けるために
    // captureFrame は JPEG のバイト列で重複を落としている）。そこで、しばらく
    // フレームが出ていないときだけ実際に 1 枚撮ってみて、**出たかどうか**で見る。
    // 通知が効いていれば絵が動いている間はフレームが流れるので、ここには来ない。
    if (nowNs() - st.lastFrameNs < kPushProbeIdleNs) {
      st.pushMissed = 0;
      return;
    }
    uint64_t before = st.lastFrameNs;
    captureFrame(st, udid);  // 取りこぼしがあればこれで埋まる
    if (st.lastFrameNs == before) {
      st.pushMissed = 0;  // 本当に画面が止まっていただけ
      return;
    }
    if (++st.pushMissed >= kPushMissTolerance) {
      fprintf(stderr, "[simhid] 変更通知が届かないためポーリングへ戻す\n");
      unregisterPush(st);
      applyCaptureTimerInterval(st);
    }
  }
}

#pragma mark - プッシュ型の取り込み（変更通知）

/**
 * ディスプレイの変更通知でフレームを撮る（docs/sidecar-protocol.md §3.7）。
 *
 * ポーリングだと「画面が変わってから次の tick まで」平均 16.7ms が構造的に乗る。
 * `SimDisplayIOSurfaceRenderable` はダメージ矩形と面の差し替えを通知できるので、
 * 変わった瞬間に撮れる。idb（`FBSimulatorControl/Framebuffer/FBFramebuffer.m`）が
 * 同じ 2 つのセレクタを使っている。
 *
 * **私有 API なので壊れうる。** 次の 3 段構えにしてある。
 * 1. `respondsToSelector:` で存在を確かめてから登録する
 * 2. **コールバックの引数を一切参照しない**（ブロックの型が違っても踏み抜かない）
 * 3. 通知が来ないのに画面が変わっていたら、ポーリングへ自動で戻す（`captureTick`）
 */

/** gCaptureQueue 上。レート制限つきで 1 枚撮る。 */
static void pushCapture(DeviceState *st, NSString *udid) {
  uint64_t now = nowNs();
  uint64_t minInterval = st.minPushIntervalNs;
  if (now - st.lastPushNs >= minInterval) {
    st.lastPushNs = now;
    st.pushPending = NO;
    captureFrame(st, udid);
    return;
  }
  // 上限より速い通知。最後の 1 回を落とさないよう、境界で流す予約だけ入れる
  st.pushPending = YES;
  if (st.pushScheduled) return;
  st.pushScheduled = YES;
  uint64_t delay = minInterval - (now - st.lastPushNs);
  __weak DeviceState *weakSt = st;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)delay), gCaptureQueue, ^{
    DeviceState *s = weakSt;
    if (!s) return;
    s.pushScheduled = NO;
    if (!s.pushPending || !s.pushMode) return;
    s.pushPending = NO;
    s.lastPushNs = nowNs();
    captureFrame(s, udid);
  });
}

static BOOL registerPush(DeviceState *st, NSString *udid) {
  if (!gPushEnabled || st.pushMode || !st.displayDescriptor) return NO;
  id desc = st.displayDescriptor;
  SEL damageSel = sel_registerName("registerCallbackWithUUID:damageRectanglesCallback:");
  SEL surfaceSel = sel_registerName("registerCallbackWithUUID:ioSurfaceChangeCallback:");
  // ROCK のリモートプロキシは respondsToSelector: に答えない。答えないものは
  // 「無い」とみなしてポーリングのままにする（誤って呼ぶより安全側）。
  if (![desc respondsToSelector:damageSel] || ![desc respondsToSelector:surfaceSel]) {
    return NO;
  }

  NSUUID *uuid = [NSUUID UUID];
  NSString *dev = [udid copy];
  __weak DeviceState *weakSt = st;

  // 引数は受け取るが**触らない**。撮り直しは常に現在の面を読み直して行う。
  void (^damageCb)(id) = ^(id ignored) {
    DeviceState *s = weakSt;
    if (!s) return;
    dispatch_async(gCaptureQueue, ^{
      if (s.pushMode) pushCapture(s, dev);
    });
  };
  // 面そのものが差し替わった（回転・解像度変更）。比較対象を落として 1 枚出す
  void (^surfaceCb)(id) = ^(id ignored) {
    DeviceState *s = weakSt;
    if (!s) return;
    dispatch_async(gCaptureQueue, ^{
      s.hasLastSeed = NO;
      s.lastJpeg = nil;
      if (s.pushMode) pushCapture(s, dev);
    });
  };

  ((void (*)(id, SEL, id, id))objc_msgSend)(desc, surfaceSel, uuid, surfaceCb);
  ((void (*)(id, SEL, id, id))objc_msgSend)(desc, damageSel, uuid, damageCb);

  st.pushUUID = uuid;
  st.pushMode = YES;
  st.pushMissed = 0;
  st.pushPending = NO;
  st.lastPushNs = 0;
  fprintf(stderr, "[simhid] 変更通知で取り込む（プッシュ型）\n");
  return YES;
}

static void unregisterPush(DeviceState *st) {
  if (!st.pushMode) return;
  st.pushMode = NO;
  st.pushPending = NO;
  id desc = st.displayDescriptor;
  NSUUID *uuid = st.pushUUID;
  st.pushUUID = nil;
  if (!desc || !uuid) return;
  // 登録したものは必ず外す（CLAUDE.md「確保したものは必ず捨てる」）
  SEL u1 = sel_registerName("unregisterIOSurfaceChangeCallbackWithUUID:");
  SEL u2 = sel_registerName("unregisterDamageRectanglesCallbackWithUUID:");
  if ([desc respondsToSelector:u1]) {
    ((void (*)(id, SEL, id))objc_msgSend)(desc, u1, uuid);
  }
  if ([desc respondsToSelector:u2]) {
    ((void (*)(id, SEL, id))objc_msgSend)(desc, u2, uuid);
  }
}

/** タイマの間隔を今のモードに合わせる。プッシュ時は生存通知のぶんだけ回す。 */
static void applyCaptureTimerInterval(DeviceState *st) {
  if (!st.captureTimer) return;
  double hz = MIN(MAX(st.fps, 1.0), 60.0);
  uint64_t frameInterval = (uint64_t)(NSEC_PER_SEC / hz);
  st.minPushIntervalNs = frameInterval;
  uint64_t interval = st.pushMode ? kPushTickIntervalNs : frameInterval;
  dispatch_source_set_timer(st.captureTimer, dispatch_time(DISPATCH_TIME_NOW, 0), interval,
                            interval / 10);
}

// gQueue 上。二重開始は no-op。
static BOOL startCapture(DeviceState *st, NSString *udid, double fps, double maxWidth,
                         double quality, BOOL sinkHttp, NSString **err) {
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
  st.fps = fps;
  st.sinkHttp = sinkHttp;
  st.hasLastSeed = NO;
  st.lastJpeg = nil;

  dispatch_source_t timer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gCaptureQueue);
  __weak DeviceState *weakSt = st;
  dispatch_source_set_event_handler(timer, ^{
    DeviceState *s = weakSt;
    if (s) captureTick(s, udid);
  });
  st.captureTimer = timer;
  st.lastAliveNs = nowNs();
  st.tickCount = 0;
  st.frameCount = 0;
  st.noSurfaceTicks = 0;
  // 変更通知が使えるなら使う。使えなければポーリングのまま（間隔はモードで決まる）
  registerPush(st, udid);
  applyCaptureTimerInterval(st);
  dispatch_resume(timer);
  return YES;
}

/**
 * 配信中の設定だけを差し替える（gQueue 上）。
 *
 * captureStop → captureStart で張り直すと、その間のフレームが落ちて画面が一瞬止まる。
 * 表示幅への追従と操作中の fps 引き上げは頻繁に起きるので、
 * 張り直さずに変えられる必要がある（docs/sidecar-protocol.md §3.5 の `captureConfig`）。
 *
 * 値の書き換えは取り込みと同じキューへ載せる（gCaptureQueue 上の captureTick が
 * 読んでいるフィールドを、別のキューから直接触らない）。
 */
static BOOL configureCapture(DeviceState *st, double fps, double maxWidth, double quality,
                             NSString **err) {
  if (!st.captureTimer) {
    *err = @"取り込みが開始されていない";
    return NO;
  }
  dispatch_source_t timer = st.captureTimer;
  __weak DeviceState *weakSt = st;
  dispatch_async(gCaptureQueue, ^{
    DeviceState *s = weakSt;
    if (!s || s.captureTimer != timer) return;  // 途中で止まった/張り直された
    s.jpegQuality = MIN(MAX(quality, 0.1), 1.0);
    s.maxWidth = maxWidth;
    // 幅や品質が変わっても画面が静止していると次のフレームが出ない
    // （seed も JPEG も同じなので捨てられる）。比較対象を落として1枚出させる。
    s.hasLastSeed = NO;
    s.lastJpeg = nil;
    s.fps = fps;
    applyCaptureTimerInterval(s);
  });
  return YES;
}

static void stopCapture(DeviceState *st) {
  if (!st.captureTimer) return;
  unregisterPush(st);
  dispatch_source_cancel(st.captureTimer);
  st.captureTimer = nil;
  st.hasLastSeed = NO;
  st.lastJpeg = nil;
  // 待っている接続を起こす（最新フレームを抱えたままにしない）
  publishFrame(st, nil);
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
    // そのまま押せば出る文字（US 配列）
    case ' ': return 0x2c;
    case '\n': return 0x28;
    case '\t': return 0x2b;
    case '-': return 0x2d;
    case '=': return 0x2e;
    case '[': return 0x2f;
    case ']': return 0x30;
    case '\\': return 0x31;
    case ';': return 0x33;
    case '\'': return 0x34;
    case '`': return 0x35;
    case ',': return 0x36;
    case '.': return 0x37;
    case '/': return 0x38;
    // Shift と組み合わせて出る文字。**ここが欠けると黙って落ちる** —
    // 以前は `:` や `?` を引けず、URL が `https//…` として入っていた。
    // 拡張ホスト側の usageForAsciiChar と同じ表（test/ascii-usage.test.js が一致を見る）
    case '!': *shift = YES; return 0x1e;
    case '@': *shift = YES; return 0x1f;
    case '#': *shift = YES; return 0x20;
    case '$': *shift = YES; return 0x21;
    case '%': *shift = YES; return 0x22;
    case '^': *shift = YES; return 0x23;
    case '&': *shift = YES; return 0x24;
    case '*': *shift = YES; return 0x25;
    case '(': *shift = YES; return 0x26;
    case ')': *shift = YES; return 0x27;
    case '_': *shift = YES; return 0x2d;
    case '+': *shift = YES; return 0x2e;
    case '{': *shift = YES; return 0x2f;
    case '}': *shift = YES; return 0x30;
    case '|': *shift = YES; return 0x31;
    case ':': *shift = YES; return 0x33;
    case '"': *shift = YES; return 0x34;
    case '~': *shift = YES; return 0x35;
    case '<': *shift = YES; return 0x36;
    case '>': *shift = YES; return 0x37;
    case '?': *shift = YES; return 0x38;
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

  // フレームの HTTP 配信。デバイスに紐づかない（1 サーバで全デバイスを捌く）。
  // ポートとトークンは親が決めて渡す（CSP は範囲で許可されるため、空き探しは親の仕事）。
  if ([name isEqualToString:@"captureServe"]) {
    NSString *serveErr = nil;
    if ([cmd[@"enable"] boolValue]) {
      NSString *token = [cmd[@"token"] isKindOfClass:NSString.class] ? cmd[@"token"] : nil;
      BOOL ok = startServe((int)numAt(cmd, @"port", 0), token, &serveErr);
      respond(reqId, ok, serveErr, -1);
    } else {
      stopServe();
      respond(reqId, YES, nil, -1);
    }
    return;
  }

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
    // mode: "auto"（既定・変更通知を試す）/ "poll"（ポーリングに固定）
    id modeVal = cmd[@"mode"];
    if ([modeVal isKindOfClass:NSString.class]) {
      gPushEnabled = ![modeVal isEqualToString:@"poll"];
    }
    ok = startCapture(st, udid, numAt(cmd, @"fps", 30), numAt(cmd, @"maxWidth", 640),
                      numAt(cmd, @"quality", 0.6),
                      [cmd[@"sink"] isEqual:@"http"], &err);
  } else if ([name isEqualToString:@"captureConfig"]) {
    ok = configureCapture(st, numAt(cmd, @"fps", 30), numAt(cmd, @"maxWidth", 640),
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

    // 接続が閉じた後の write でプロセスごと落ちない（配信用ソケットは SO_NOSIGPIPE も張る）
    signal(SIGPIPE, SIG_IGN);

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
