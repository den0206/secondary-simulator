import Foundation
import ObjectiveC.runtime

// CoreSimulator / SimulatorKit を dlopen して ObjC ランタイムから構造を覗く
let coreSim = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator"
let simKit = "/Applications/Xcode-26.6.0.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit"

for p in [coreSim, simKit] {
    if dlopen(p, RTLD_NOW) == nil {
        print("dlopen FAILED: \(p) — \(String(cString: dlerror()))")
    } else {
        print("dlopen ok: \((p as NSString).lastPathComponent)")
    }
}

func dumpMethods(_ className: String, filter: [String]) {
    guard let cls = objc_lookUpClass(className) else {
        print("\n[\(className)] クラスが見つからない")
        return
    }
    print("\n[\(className)] メソッド:")
    var count: UInt32 = 0
    if let list = class_copyMethodList(cls, &count) {
        var hits: [String] = []
        for i in 0..<Int(count) {
            let name = NSStringFromSelector(method_getName(list[i]))
            if filter.isEmpty || filter.contains(where: { name.lowercased().contains($0) }) {
                hits.append("  - \(name)")
            }
        }
        print(hits.isEmpty ? "  (該当なし)" : hits.sorted().joined(separator: "\n"))
        free(list)
    }
    // クラスメソッドも
    if let meta = object_getClass(cls) {
        var c2: UInt32 = 0
        if let list = class_copyMethodList(meta, &c2) {
            var hits: [String] = []
            for i in 0..<Int(c2) {
                let name = NSStringFromSelector(method_getName(list[i]))
                if filter.isEmpty || filter.contains(where: { name.lowercased().contains($0) }) {
                    hits.append("  + \(name)")
                }
            }
            if !hits.isEmpty { print(hits.sorted().joined(separator: "\n")) }
            free(list)
        }
    }
}

dumpMethods("SimDevice", filter: ["hid", "indigo", "io", "port", "send"])
dumpMethods("SimDeviceIO", filter: [])
dumpMethods("SimDeviceIOClient", filter: [])

// Indigo 系 C 関数が dlsym で引けるか
print("\n[dlsym] IndigoHID C 関数:")
let handle = dlopen(simKit, RTLD_NOW)
for sym in [
    "IndigoHIDMessageForButton",
    "IndigoHIDMessageForTrackpadEventFromHIDEventRef",
    "IndigoHIDMessageForPointerEventFromHIDEventRef",
    "IndigoHIDMessageForKeyboardNSEvent",
    "IndigoHIDMessageForScrollEvent",
    "IndigoHIDMessageToCreatePointerService",
] {
    print("  \(dlsym(handle, sym) != nil ? "✅" : "❌") \(sym)")
}

// SimDeviceLegacyHIDClient の Swift シンボルが引けるか
print("\n[dlsym] SimDeviceLegacyHIDClient の Swift シンボル:")
for (label, sym) in [
    ("init(device:) throws", "$s12SimulatorKit24SimDeviceLegacyHIDClientC6deviceACSo0cD0C_tKcfC"),
    ("send(message:)", "$s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tF"),
    ("send(message:) dispatch thunk", "$s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tFTj"),
    ("resetHIDSession()", "$s12SimulatorKit24SimDeviceLegacyHIDClientC15resetHIDSessionyyFTj"),
] {
    print("  \(dlsym(handle, sym) != nil ? "✅" : "❌") \(label)")
}

// IOHIDEvent 系（IOKit）
print("\n[dlsym] IOKit のデジタイザイベント生成:")
let iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW)
for sym in ["IOHIDEventCreateDigitizerEvent", "IOHIDEventCreateDigitizerFingerEvent", "IOHIDEventAppendEvent"] {
    print("  \(dlsym(iokit, sym) != nil ? "✅" : "❌") \(sym)")
}
