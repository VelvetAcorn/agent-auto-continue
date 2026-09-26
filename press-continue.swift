import AppKit
import ApplicationServices

func fail(_ message: String) -> Never {
    fputs("\(message) Nothing sent.\n", stderr)
    exit(1)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else {
        return nil
    }
    return result
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return nil
    }
    return (value as! AXUIElement)
}

let args = Array(CommandLine.arguments.dropFirst())
guard args == ["check"] || (args.count == 2 && args[0] == "send") else {
    fail("Usage: press-continue check | send CHAT_URL.")
}
guard AXIsProcessTrusted() else {
    fail("Allow the app running this script (usually Terminal) in System Settings > Privacy & Security > Accessibility, then rerun.")
}
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.t3tools.t3code").first else {
    fail("T3 Code must already be running.")
}
let appElement = AXUIElementCreateApplication(app.processIdentifier)
// Electron can disable its accessibility tree until an accessibility client asks.
AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
guard app.activate(options: []) else {
    fail("Could not bring T3 Code forward.")
}

var focused: AXUIElement?
for _ in 0..<30 {
    if app.isActive, let candidate = elementAttribute(appElement, kAXFocusedUIElementAttribute) {
        focused = candidate
        break
    }
    Thread.sleep(forTimeInterval: 0.1)
}
guard app.isActive, let input = focused else {
    fail("Could not read T3 Code's focused input. Unlock the Mac and focus the chat input.")
}
guard attribute(input, kAXRoleAttribute) as? String == kAXTextAreaRole else {
    fail("Focus the chat message input in T3 Code first.")
}
guard attribute(input, kAXValueAttribute) as? String == "continue" else {
    fail("The focused input must contain exactly continue.")
}

var ancestor = input
var chatURL: String?
for _ in 0..<40 {
    if attribute(ancestor, kAXRoleAttribute) as? String == "AXWebArea" {
        if let url = attribute(ancestor, kAXURLAttribute) as? URL {
            chatURL = url.absoluteString
        } else {
            chatURL = attribute(ancestor, kAXURLAttribute) as? String
        }
        break
    }
    guard let parent = elementAttribute(ancestor, kAXParentAttribute) else { break }
    ancestor = parent
}
guard let url = chatURL, url.hasPrefix("t3code://app/#/"), url != "t3code://app/#/" else {
    fail("Cannot identify the T3 chat.")
}

if args[0] == "send" {
    guard url == args[1] else { fail("The selected T3 chat changed.") }
    guard app.isActive,
          let currentInput = elementAttribute(appElement, kAXFocusedUIElementAttribute),
          CFEqual(input, currentInput),
          attribute(input, kAXValueAttribute) as? String == "continue" else {
        fail("T3 Code's input or focus changed.")
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) else {
        fail("Could not create the Enter key event.")
    }
    down.flags = []
    up.flags = []
    down.postToPid(app.processIdentifier)
    up.postToPid(app.processIdentifier)
}
print(url)
