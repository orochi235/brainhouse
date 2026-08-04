// brainhouse menu bar helper. Single file, compiled by scripts/install-menubar.sh.
// Polls the local server for health + awaiting-input count; Start/Stop/Restart
// drive the com.brainhouse LaunchAgent (never dev servers).
import AppKit
import WebKit

let port = Int(ProcessInfo.processInfo.environment["PORT"] ?? "") ?? 8765
let dashboardURL = URL(string: "http://localhost:\(port)/")!
let healthURL = URL(string: "http://localhost:\(port)/health")!
let summaryURL = URL(string: "http://localhost:\(port)/api/summary")!
let serviceLabel = "com.brainhouse"
// Open Dashboard opens a Chrome tab (falling back to the default browser)
// instead of the embedded WebKit window. The WebKit path is disabled, not
// removed — flip this to bring the native window back.
let useWebKitDashboard = false
let logsDir = ("~/Library/Logs/brainhouse" as NSString).expandingTildeInPath
let plistPath = ("~/Library/LaunchAgents/\(serviceLabel).plist" as NSString).expandingTildeInPath

enum ServerState: Equatable {
    case running(awaitingInput: Int)
    case stopped
    case unhealthy
}

/// Whether launchd knows about the agent. `unloaded` is a real, reachable state
/// — Stop boots the agent out entirely — and it is NOT the same as "not
/// installed": the plist is still on disk and only needs bootstrapping.
enum ServiceState {
    case notInstalled
    case unloaded
    case loaded
}

func launchctl(_ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var state = ServerState.stopped

    // The dashboard is a single long-lived window: Open Dashboard shows this
    // one or raises it, never a second copy.
    private var dashboardWindow: NSWindow?
    private var dashboardWebView: WKWebView?
    private var dashboardLoadFailed = false
    private var dashboardKeyMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        render()
        let timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
        timer.fire()
    }

    // MARK: - Polling

    private func poll() {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            guard let self else { return }
            if let error = error as NSError? {
                let refused = error.code == NSURLErrorCannotConnectToHost || error.code == NSURLErrorCannotFindHost
                self.setState(refused ? .stopped : .unhealthy)
                return
            }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                self.setState(.unhealthy)
                return
            }
            self.fetchSummary()
        }.resume()
    }

    private func fetchSummary() {
        var request = URLRequest(url: summaryURL)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            let count = data
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                .flatMap { $0["awaiting_input"] as? Int } ?? 0
            self?.setState(.running(awaitingInput: count))
        }.resume()
    }

    private func setState(_ new: ServerState) {
        DispatchQueue.main.async {
            guard new != self.state else { return }
            self.state = new
            self.render()
        }
    }

    // MARK: - Status item

    private func render() {
        guard let button = statusItem.button else { return }
        button.imagePosition = .imageLeading
        switch state {
        case .running(let n):
            button.image = NSImage(systemSymbolName: "brain", accessibilityDescription: "brainhouse running")
            button.appearsDisabled = false
            button.title = n > 0 ? " \(n)" : ""
        case .stopped:
            button.image = NSImage(systemSymbolName: "brain", accessibilityDescription: "brainhouse stopped")
            button.appearsDisabled = true
            button.title = ""
        case .unhealthy:
            button.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "brainhouse not responding")
            button.appearsDisabled = false
            button.title = ""
        }
    }

    private func statusLine() -> String {
        switch state {
        case .running(let n):
            return n > 0 ? "Server: running on :\(port) — \(n) awaiting input" : "Server: running on :\(port)"
        case .stopped:
            return "Server: not running"
        case .unhealthy:
            return "Server: not responding on :\(port)"
        }
    }

    private func serviceState() -> ServiceState {
        if launchctl(["print", "gui/\(getuid())/\(serviceLabel)"]) == 0 { return .loaded }
        return FileManager.default.fileExists(atPath: plistPath) ? .unloaded : .notInstalled
    }

    private func serviceLine(_ service: ServiceState) -> String {
        switch service {
        case .notInstalled: return "Service: not installed"
        case .unloaded:     return "Service: installed, not loaded"
        case .loaded:       return "Service: loaded"
        }
    }

    // MARK: - Menu (rebuilt on every open so the actions reflect reality)

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let service = serviceState()

        // Two read-only lines: is the server answering, and does launchd hold
        // the agent. They can disagree — a loaded agent whose process died
        // reads "loaded" + "not running" — and that difference decides which
        // actions below make sense.
        menu.addItem(infoItem(statusLine()))
        menu.addItem(infoItem(serviceLine(service)))
        menu.addItem(.separator())
        menu.addItem(makeItem("Open Dashboard", #selector(openDashboard)))

        switch service {
        case .notInstalled:
            menu.addItem(infoItem("Install with: npm run service:install"))
        case .unloaded:
            // Nothing to stop or restart — it must be bootstrapped first.
            menu.addItem(makeItem("Start Service", #selector(startService)))
        case .loaded:
            if case .running = state {
                menu.addItem(makeItem("Restart Service", #selector(restartService)))
            } else {
                // Loaded but not answering: kickstart is the way back up, so
                // offer Start rather than a Restart of something that's down.
                menu.addItem(makeItem("Start Service", #selector(startService)))
            }
            menu.addItem(makeItem("Stop Service", #selector(stopService)))
        }

        menu.addItem(makeItem("Open Logs", #selector(openLogs)))
        menu.addItem(.separator())
        menu.addItem(makeItem("Quit", #selector(quit), key: "q"))
    }

    /// A read-only line. A nil action leaves the item disabled.
    private func infoItem(_ title: String) -> NSMenuItem {
        NSMenuItem(title: title, action: nil, keyEquivalent: "")
    }

    private func makeItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // MARK: - Actions

    @objc private func openDashboard() {
        guard useWebKitDashboard else {
            openDashboardInBrowser()
            return
        }
        if let window = dashboardWindow {
            // Held open across a service restart, the page is dead HTML. Only
            // reload in that case, so the usual reopen keeps scroll position
            // and whatever the user had expanded or filtered.
            if dashboardLoadFailed { loadDashboard() }
            showDashboard(window)
            return
        }

        let webView = WKWebView(frame: .zero)
        webView.navigationDelegate = self
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "brainhouse"
        window.contentView = webView
        // Closing the window hides it rather than destroying it — that is what
        // makes reopening cheap and stateful. Without this, AppKit frees the
        // window on close and the next open would rebuild the WebView.
        window.isReleasedWhenClosed = false
        window.center()
        // Applied after center() so a remembered size and position wins.
        window.setFrameAutosaveName("BrainhouseDashboard")

        dashboardWindow = window
        dashboardWebView = webView
        installDashboardKeyMonitor()
        loadDashboard()
        showDashboard(window)
    }

    /// Chrome when it's installed; default browser otherwise.
    private func openDashboardInBrowser() {
        if let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
            NSWorkspace.shared.open([dashboardURL], withApplicationAt: chrome,
                                    configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(dashboardURL)
        }
    }

    private func showDashboard(_ window: NSWindow) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Always a fresh load rather than `reload()`, which does nothing when the
    /// first navigation failed and left no back-forward entry to reload.
    private func loadDashboard() {
        dashboardLoadFailed = false
        dashboardWebView?.load(URLRequest(url: dashboardURL))
    }

    /// An `.accessory` app owns no menu bar, so Cmd-W and Cmd-R never reach the
    /// window through the usual responder path. Wire up just those two.
    private func installDashboardKeyMonitor() {
        guard dashboardKeyMonitor == nil else { return }
        dashboardKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let window = self.dashboardWindow, window.isKeyWindow,
                  event.modifierFlags.contains(.command) else { return event }
            switch event.charactersIgnoringModifiers {
            case "w": window.orderOut(nil); return nil
            case "r": self.loadDashboard(); return nil
            default: return event
            }
        }
    }

    @objc private func openLogs() { NSWorkspace.shared.open(URL(fileURLWithPath: logsDir, isDirectory: true)) }
    // Stop boots the agent out, so Start has to be able to bootstrap it back
    // in — kickstart alone fails on an agent launchd no longer knows about,
    // which used to leave the menu with no way to restart the service.
    @objc private func startService() {
        if serviceState() == .unloaded {
            runLaunchctlOrAlert(["bootstrap", "gui/\(getuid())", plistPath])
        } else {
            runLaunchctlOrAlert(["kickstart", "-k", "gui/\(getuid())/\(serviceLabel)"])
        }
    }
    @objc private func restartService() { runLaunchctlOrAlert(["kickstart", "-k", "gui/\(getuid())/\(serviceLabel)"]) }
    @objc private func stopService() { runLaunchctlOrAlert(["bootout", "gui/\(getuid())/\(serviceLabel)"]) }
    @objc private func quit() { NSApp.terminate(nil) }

    private func runLaunchctlOrAlert(_ args: [String]) {
        DispatchQueue.global().async { [weak self] in
            let status = launchctl(args)
            DispatchQueue.main.async {
                if status != 0 {
                    let alert = NSAlert()
                    alert.messageText = "launchctl failed (exit \(status))"
                    alert.informativeText = "launchctl " + args.joined(separator: " ")
                    alert.runModal()
                }
                self?.poll()
            }
        }
    }
}

// Track whether the loaded page is usable, so a reopen after the server went
// away reloads instead of re-showing WebKit's error page.
extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        dashboardLoadFailed = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        dashboardLoadFailed = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        dashboardLoadFailed = true
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
