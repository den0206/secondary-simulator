// node test/remote-input.device-test.js [UDID]
// A temporary UIKit app records what actually arrived, without WDA or OCR.
// Keep the simulator displayed in Device Hub to exercise coexistence.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
require('./helpers/vscode-stub').installVerbose();
const {SimulatorInputController} = require('../out/input/SimulatorInputController');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundle = 'dev.secondarysimulator.inputcheck';

const source = `
#import <UIKit/UIKit.h>
@interface App : UIResponder <UIApplicationDelegate, UIWindowSceneDelegate>
@property UIWindow *window;
@property UITextField *field;
@property NSInteger pinches;
@property CGFloat scale;
@end
@implementation App
- (void)save {
  NSDictionary *state = @{@"text": self.field.text ?: @"", @"pinches": @(self.pinches), @"scale": @(self.scale)};
  NSString *file = [NSHomeDirectory() stringByAppendingPathComponent:@"Documents/input.json"];
  [NSFileManager.defaultManager createDirectoryAtPath:file.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
  [[NSJSONSerialization dataWithJSONObject:state options:0 error:nil] writeToFile:file atomically:YES];
}
- (void)edit:(UITextField *)field { [self save]; }
- (void)pinch:(UIPinchGestureRecognizer *)gesture {
  if (gesture.state == UIGestureRecognizerStateEnded) {
    self.pinches++;
    self.scale = gesture.scale;
    [self save];
  }
}
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
  return YES;
}
- (UISceneConfiguration *)application:(UIApplication *)app configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *config = [[UISceneConfiguration alloc] initWithName:@"InputCheck" sessionRole:session.role];
  config.delegateClass = App.class;
  return config;
}
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  UIViewController *vc = [UIViewController new];
  vc.view.backgroundColor = UIColor.systemBackgroundColor;
  CGFloat w = self.window.bounds.size.width, h = self.window.bounds.size.height;
  self.field = [[UITextField alloc] initWithFrame:CGRectMake(w*.1, h*.17, w*.8, h*.06)];
  self.field.borderStyle = UITextBorderStyleRoundedRect;
  self.field.keyboardType = UIKeyboardTypeASCIICapable;
  self.field.autocorrectionType = UITextAutocorrectionTypeNo;
  self.field.autocapitalizationType = UITextAutocapitalizationTypeNone;
  [self.field addTarget:self action:@selector(edit:) forControlEvents:UIControlEventEditingChanged];
  [vc.view addSubview:self.field];
  UIView *pad = [[UIView alloc] initWithFrame:CGRectMake(0, h*.4, w, h*.4)];
  pad.backgroundColor = UIColor.systemBlueColor;
  [pad addGestureRecognizer:[[UIPinchGestureRecognizer alloc] initWithTarget:self action:@selector(pinch:)]];
  [vc.view addSubview:pad];
  self.window.rootViewController = vc;
  [self.window makeKeyAndVisible];
  [self save];
}
@end
int main(int argc, char **argv) {
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(App.class)); }
}
`;

(async () => {
  const {stdout} = await run('xcrun', ['simctl', 'list', 'devices', 'booted']);
  const udid = process.argv[2] || stdout.match(/\(([0-9A-F-]{36})\) \(Booted\)/)?.[1];
  assert.ok(udid, 'Boot a simulator first');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sim-input-check-'));
  const app = path.join(dir, 'InputCheck.app');
  let installed = false, controller;
  try {
    await fs.mkdir(app);
    await fs.writeFile(path.join(dir, 'main.m'), source);
    await fs.writeFile(path.join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundleExecutable</key><string>InputCheck</string>
      <key>CFBundleName</key><string>InputCheck</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>CFBundleShortVersionString</key><string>1.0</string>
      <key>LSRequiresIPhoneOS</key><true/>
      <key>UILaunchScreen</key><dict/>
      <key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
    </dict></plist>`);
    const sdk = (await run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'])).stdout.trim();
    const arch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
    await run('xcrun', ['clang', '-fobjc-arc', '-target', `${arch}-apple-ios18.0-simulator`,
      '-isysroot', sdk, '-framework', 'UIKit', '-framework', 'Foundation',
      path.join(dir, 'main.m'), '-o', path.join(app, 'InputCheck')]);
    await run('codesign', ['--force', '--sign', '-', app]);
    await run('xcrun', ['simctl', 'install', udid, app]);
    installed = true;
    await run('xcrun', ['simctl', 'launch', udid, bundle]);
    const container = (await run('xcrun', ['simctl', 'get_app_container', udid, bundle, 'data'])).stdout.trim();
    const state = async () => JSON.parse(await fs.readFile(path.join(container, 'Documents/input.json'), 'utf8'));
    const waitFor = async predicate => {
      for (let i = 0; i < 40; i++) {
        const value = await state().catch(() => null);
        if (value && predicate(value)) return value;
        await sleep(100);
      }
      assert.fail(`Input not received: ${JSON.stringify(await state())}`);
    };
    await waitFor(() => true);
    await sleep(1000);
    controller = new SimulatorInputController({
      deviceId: udid, platform: 'ios', type: 'simulator', version: '27.0',
      mobileCliClient: new Proxy({}, {get: (_, key) => () => { throw Error(`Unexpected WDA: ${String(key)}`); }}),
      getScreenSize: () => null,
      sidecarBinaryPath: path.resolve(__dirname, '../native/simhid-server'),
    });
    await controller.init();
    assert.equal(controller.backendKind, 'hid');
    await controller.touchDown(.5, .2);
    await sleep(60);
    await controller.touchUp(.5, .2);
    await sleep(500);
    await controller.text('Hello27!');
    await waitFor(s => s.text === 'Hello27!');
    console.log('PASS: ASCII text, Shift and punctuation received');
    await controller.keypress('a', false, ['command']);
    await controller.text('Replaced');
    await waitFor(s => s.text === 'Replaced');
    console.log('PASS: Command+A and replacement received');
    await controller.touch2Down(.35, .6, .65, .6);
    for (let i = 1; i <= 20; i++) {
      await controller.touch2Move(.35 - i*.01, .6, .65 + i*.01, .6);
      await sleep(20);
    }
    await controller.touch2Up(.15, .6, .85, .6);
    const value = await waitFor(s => s.pinches > 0);
    assert.ok(value.scale > 1.5, `Unexpected pinch scale: ${value.scale}`);
    console.log(`PASS: two-finger pinch received (scale=${value.scale.toFixed(2)})`);
  } finally {
    controller?.dispose();
    if (installed) await run('xcrun', ['simctl', 'uninstall', udid, bundle]);
    await fs.rm(dir, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
