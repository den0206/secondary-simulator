// iOS Simulator への HID 直接注入 — 検証済みの参照実装
//
//   clang -fobjc-arc -framework Foundation -framework CoreFoundation -o simhid simhid.m
//   xcrun simctl boot <UDID>
//
//   simhid <udid> tap    <x> <y>                 タップ
//   simhid <udid> drag   <x1> <y1> <x2> <y2>     ドラッグ（スクロール）
//   simhid <udid> pinch  <cx> <cy> <r1> <r2>     2本指ピンチ
//   simhid <udid> home                           ホームボタン
//   simhid <udid> lock                           電源/ロックボタン
//   simhid <udid> type   <ASCII文字列>            キーボード入力
//   simhid <udid> key    <usageCode>             単一キー（USB HID usage）
//   simhid <udid> bench  <x> <y>                 送信遅延の計測
//
// 座標は全て 0.0〜1.0 の正規化座標。
// 仕様の根拠と落とし穴は docs/ios-hid-injection.md を参照。
// 全て非公開 API に依存しているため、Xcode の更新で壊れうる。
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

#pragma mark - 復元した private API

// (点1, 点2 or NULL, target, NSEventType, ボタン番号, スケールX, スケールY)
typedef void *(*MouseMsgFn)(const CGPoint *p1, const CGPoint *p2, uint64_t target,
                            uint64_t nsEventType, uint64_t buttonNumber, double sx, double sy);
// (keyCode, op, target)   op: 1=押下 2=解放
typedef void *(*ButtonMsgFn)(uint32_t keyCode, uint32_t op, uint32_t target);
// (usageCode, op)         op: 1=押下 2=解放。target 不要（内部で 10000 固定）
typedef void *(*KeyMsgFn)(uint64_t usageCode, uint64_t op);
// (bit, op)               bit: 16..20 のみ有効。op: 非0=押下 0=解放
typedef void *(*ModMsgFn)(uint32_t bit, uint64_t op);

// target 定数。誤ると受信側が壊れる（docs 参照）
static const uint64_t kTouchTarget = 0x32;   // タッチ/ドラッグ/ピンチ
static const uint32_t kButtonTarget = 0x33;  // ハードウェアボタン

// NSEventType
enum { kMouseDown = 1, kMouseUp = 2, kMouseDragged = 6 };
// ハードウェアボタンの keyCode（実機で確認できたのはこの2つだけ）
enum { kButtonHome = 0, kButtonLock = 1 };
// 修飾キーの bit（bit-0x10 でテーブル参照するため 16..20 以外は範囲外読みになる）
enum { kModCapsLock = 16, kModShift = 17, kModControl = 18, kModOption = 19, kModCommand = 20 };

// ドラッグは前回から約16ms 空けないと生成関数が NULL を返す（0xF423FF ns のレートリミッタ）
static const useconds_t kDragIntervalUs = 17000;

#pragma mark - 状態

static id gDevice;
static Class gHidCls;
static id gClient;
static SEL gSendSel;
static MouseMsgFn mouseMsg;
static ButtonMsgFn buttonMsg;
static KeyMsgFn keyMsg;
static ModMsgFn modMsg;

#pragma mark - 送信

static BOOL createClient(void) {
  NSError *err = nil;
  gClient = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
      [gHidCls alloc], sel_registerName("initWithDevice:error:"), gDevice, &err);
  if (!gClient) fprintf(stderr, "HID クライアント生成失敗: %s\n", err.description.UTF8String);
  return gClient != nil;
}

// メッセージは calloc 由来。freeWhenDone:NO で送り、自分で解放する
// （YES にすると解放済みポインタを再送しうるので二重解放でクラッシュする）
//
// 復旧について: resetHIDSession は「復旧しない」。呼ぶとむしろ machPortNotConnected になる。
// 正しい復旧手段はクライアントの作り直し。
static double sendMessage(void *msg) {
  if (!msg) return -1;
  uint64_t t0 = clock_gettime_nsec_np(CLOCK_MONOTONIC);
  for (int attempt = 0; attempt < 2; attempt++) {
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSError *err = nil;
    ((void (*)(id, SEL, void *, BOOL, id, id))objc_msgSend)(
        gClient, gSendSel, msg, NO, dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0),
        ^(NSError *e) { err = e; dispatch_semaphore_signal(sem); });
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    if (!err) break;
    if (attempt == 0) { createClient(); continue; }
    fprintf(stderr, "  送信エラー: %s\n", err.description.UTF8String);
  }
  double ms = (clock_gettime_nsec_np(CLOCK_MONOTONIC) - t0) / 1e6;
  free(msg);
  return ms;
}

#pragma mark - 入力プリミティブ

// phase: 0=down, 1=drag, 2=up。p2 を渡すと2本指になる
static double touch(double x, double y, const CGPoint *p2, int phase) {
  static const uint64_t kType[] = {kMouseDown, kMouseDragged, kMouseUp};
  CGPoint p1 = {x, y};
  void *msg = mouseMsg(&p1, p2, kTouchTarget, kType[phase], 0, 1.0, 1.0);
  if (!msg) return -1;  // drag のレートリミッタに引っかかった
  return sendMessage(msg);
}

static void pressButton(uint32_t code) {
  sendMessage(buttonMsg(code, 1, kButtonTarget));
  usleep(60000);
  sendMessage(buttonMsg(code, 2, kButtonTarget));
}

// ASCII → USB HID Keyboard usage code。shift が要るなら *shift に YES
static uint8_t usageForChar(char c, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') return 4 + (c - 'a');
  if (c >= 'A' && c <= 'Z') { *shift = YES; return 4 + (c - 'A'); }
  if (c >= '1' && c <= '9') return 0x1e + (c - '1');
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

static void sendText(const char *text, int *sent, int *skipped) {
  *sent = *skipped = 0;
  for (const char *p = text; *p; p++) {
    BOOL shift = NO;
    uint8_t u = usageForChar(*p, &shift);
    if (!u) { (*skipped)++; continue; }
    if (shift) { sendMessage(modMsg(kModShift, 1)); usleep(8000); }
    sendMessage(keyMsg(u, 1));
    usleep(12000);
    sendMessage(keyMsg(u, 2));
    if (shift) { usleep(8000); sendMessage(modMsg(kModShift, 0)); }
    usleep(20000);
    (*sent)++;
  }
}

#pragma mark - 起動

static NSString *developerDir(void) {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
  t.arguments = @[ @"-p" ];
  NSPipe *pipe = [NSPipe pipe];
  t.standardOutput = pipe;
  [t launchAndReturnError:nil];
  NSData *d = [pipe.fileHandleForReading readDataToEndOfFile];
  [t waitUntilExit];
  return [[[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static BOOL setup(NSString *udid) {
  NSString *dev = developerDir();
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator", RTLD_NOW)) {
    fprintf(stderr, "CoreSimulator を読み込めない\n");
    return NO;
  }
  NSString *simKitPath = [dev stringByAppendingPathComponent:
      @"Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit"];
  void *sk = dlopen(simKitPath.UTF8String, RTLD_NOW);
  if (!sk) { fprintf(stderr, "SimulatorKit を読み込めない: %s\n", simKitPath.UTF8String); return NO; }

  mouseMsg = (MouseMsgFn)dlsym(sk, "IndigoHIDMessageForMouseNSEvent");
  buttonMsg = (ButtonMsgFn)dlsym(sk, "IndigoHIDMessageForButton");
  keyMsg = (KeyMsgFn)dlsym(sk, "IndigoHIDMessageForKeyboardArbitrary");
  modMsg = (ModMsgFn)dlsym(sk, "IndigoHIDMessageForModifierKeyBit");
  if (!mouseMsg || !buttonMsg || !keyMsg || !modMsg) {
    fprintf(stderr, "Indigo シンボルを解決できない（Xcode の更新で変わった可能性）\n");
    return NO;
  }

  NSError *err = nil;
  id ctx = ((id (*)(Class, SEL, id, NSError **))objc_msgSend)(
      objc_lookUpClass("SimServiceContext"),
      sel_registerName("sharedServiceContextForDeveloperDir:error:"), dev, &err);
  if (!ctx) { fprintf(stderr, "SimServiceContext 取得失敗: %s\n", err.description.UTF8String); return NO; }
  id set = ((id (*)(id, SEL, NSError **))objc_msgSend)(
      ctx, sel_registerName("defaultDeviceSetWithError:"), &err);
  for (id d in (NSArray *)((id (*)(id, SEL))objc_msgSend)(set, sel_registerName("devices"))) {
    NSUUID *u = ((id (*)(id, SEL))objc_msgSend)(d, sel_registerName("UDID"));
    if ([u.UUIDString caseInsensitiveCompare:udid] == NSOrderedSame) { gDevice = d; break; }
  }
  if (!gDevice) { fprintf(stderr, "デバイスが見つからない: %s\n", udid.UTF8String); return NO; }

  // Swift クラスだが NSObject 継承なので ObjC ランタイムに登録されている
  gHidCls = objc_lookUpClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
  if (!gHidCls) { fprintf(stderr, "HID クライアントクラスが見つからない\n"); return NO; }
  gSendSel = sel_registerName("sendWithMessage:freeWhenDone:completionQueue:completion:");
  return createClient();
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr,
              "usage: simhid <udid> <tap|drag|pinch|home|lock|type|key|bench> ...\n");
      return 2;
    }
    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    NSString *mode = [NSString stringWithUTF8String:argv[2]];
    if (!setup(udid)) return 1;

    if ([mode isEqualToString:@"tap"] && argc >= 5) {
      double x = atof(argv[3]), y = atof(argv[4]);
      double d = touch(x, y, NULL, 0);
      usleep(40000);
      double u = touch(x, y, NULL, 2);
      printf("tap (%.3f, %.3f)  down=%.3fms up=%.3fms\n", x, y, d, u);

    } else if ([mode isEqualToString:@"drag"] && argc >= 7) {
      double x1 = atof(argv[3]), y1 = atof(argv[4]), x2 = atof(argv[5]), y2 = atof(argv[6]);
      int steps = argc >= 8 ? atoi(argv[7]) : 30;
      int dropped = 0;
      touch(x1, y1, NULL, 0);
      usleep(kDragIntervalUs);
      for (int i = 1; i <= steps; i++) {
        double t = (double)i / steps;
        if (touch(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, NULL, 1) < 0) dropped++;
        usleep(kDragIntervalUs);
      }
      touch(x2, y2, NULL, 2);
      printf("drag (%.3f,%.3f)->(%.3f,%.3f) %dステップ（レートリミッタで %d 件破棄）\n",
             x1, y1, x2, y2, steps, dropped);

    } else if ([mode isEqualToString:@"pinch"] && argc >= 7) {
      double cx = atof(argv[3]), cy = atof(argv[4]);
      double r1 = atof(argv[5]), r2 = atof(argv[6]);
      int steps = argc >= 8 ? atoi(argv[7]) : 20;
      CGPoint q = {cx, cy - r1};
      touch(cx, cy + r1, &q, 0);
      usleep(kDragIntervalUs);
      for (int i = 1; i <= steps; i++) {
        double t = (double)i / steps;
        double r = r1 + (r2 - r1) * t;
        CGPoint qq = {cx, cy - r};
        touch(cx, cy + r, &qq, 1);
        usleep(kDragIntervalUs);
      }
      CGPoint qe = {cx, cy - r2};
      touch(cx, cy + r2, &qe, 2);
      printf("pinch 中心(%.2f,%.2f) 半径 %.2f→%.2f\n", cx, cy, r1, r2);

    } else if ([mode isEqualToString:@"home"]) {
      pressButton(kButtonHome);
      printf("home\n");

    } else if ([mode isEqualToString:@"lock"]) {
      pressButton(kButtonLock);
      printf("lock\n");

    } else if ([mode isEqualToString:@"type"] && argc >= 4) {
      int sent = 0, skipped = 0;
      sendText(argv[3], &sent, &skipped);
      printf("type: %d 文字送信（%d 文字は未対応でスキップ）\n", sent, skipped);

    } else if ([mode isEqualToString:@"key"] && argc >= 4) {
      uint64_t u = strtoull(argv[3], NULL, 0);
      sendMessage(keyMsg(u, 1));
      usleep(15000);
      sendMessage(keyMsg(u, 2));
      printf("key 0x%llx\n", u);

    } else if ([mode isEqualToString:@"bench"] && argc >= 5) {
      double x = atof(argv[3]), y = atof(argv[4]);
      const int n = 60;
      double total = 0;
      int ok = 0;
      touch(x, y, NULL, 0);
      usleep(kDragIntervalUs);
      for (int i = 0; i < n; i++) {
        double ms = touch(x, y + 0.0001 * (i % 2), NULL, 1);
        if (ms >= 0) { total += ms; ok++; }
        usleep(kDragIntervalUs);
      }
      touch(x, y, NULL, 2);
      printf("move 1件あたり平均 %.3f ms（%d/%d 件成功）\n", ok ? total / ok : -1, ok, n);

    } else {
      fprintf(stderr, "引数が足りないか未知のモード: %s\n", mode.UTF8String);
      return 2;
    }
  }
  return 0;
}
