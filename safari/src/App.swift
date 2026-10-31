import AppKit
import SafariServices

let extensionId = "com.pigeonposse.magicbar.Extension"

final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!

    func applicationDidFinishLaunching(_ n: Notification) {
        let text = NSTextField(wrappingLabelWithString:
            "MagicBar for YouTube is installed.\n\n1. Click the button below to open Safari's extension settings.\n2. Enable \"MagicBar for YouTube\" and allow it on youtube.com.\n\nIf it is not listed, enable Develop > Allow Unsigned Extensions in Safari first.")
        text.frame = NSRect(x: 24, y: 80, width: 392, height: 130)
        let button = NSButton(title: "Open Safari Extension Settings", target: self, action: #selector(openSettings))
        button.frame = NSRect(x: 24, y: 28, width: 260, height: 32)
        button.bezelStyle = .rounded
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 230),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "MagicBar for YouTube"
        window.contentView?.addSubview(text)
        window.contentView?.addSubview(button)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func openSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionId) { _ in }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
