// brainhouse menu bar helper. Single file, compiled by scripts/install-menubar.sh.
// Polls the local server for health + awaiting-input count; Start/Stop/Restart
// drive the com.brainhouse LaunchAgent (never dev servers).
import AppKit
import UserNotifications
import WebKit

let port = Int(ProcessInfo.processInfo.environment["PORT"] ?? "") ?? 8765
let dashboardURL = URL(string: "http://localhost:\(port)/")!
let healthURL = URL(string: "http://localhost:\(port)/health")!
let summaryURL = URL(string: "http://localhost:\(port)/api/summary")!
let revealURL = URL(string: "http://localhost:\(port)/api/reveal")!
let notificationsToggleURL = URL(string: "http://localhost:\(port)/api/notifications")!
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

    // Alert delivery state. The cursor is seeded silently from the first
    // poll so a helper restart never replays banners the server still
    // holds; the server owns every other decision (grace, dedupe, expiry).
    private var alertCursor: Int = -1
    private var alertCursorSeeded = false
    private var notificationsEnabled = true
    private var notificationsAuthDenied = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        render()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            DispatchQueue.main.async { self?.notificationsAuthDenied = !granted }
        }
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
            self?.fetchAlerts()
        }.resume()
    }

    // MARK: - Alert delivery

    private func fetchAlerts() {
        var request = URLRequest(url: URL(string: "http://localhost:\(port)/api/alerts?after=\(alertCursor)")!)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self,
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            DispatchQueue.main.async {
                self.notificationsEnabled = obj["enabled"] as? Bool ?? true
                let alerts = obj["alerts"] as? [[String: Any]] ?? []
                let maxId = alerts.compactMap { $0["id"] as? Int }.max() ?? self.alertCursor
                if !self.alertCursorSeeded {
                    self.alertCursorSeeded = true
                    self.alertCursor = maxId
                    return
                }
                for alert in alerts { self.post(alert: alert) }
                self.alertCursor = max(self.alertCursor, maxId)
            }
        }.resume()
    }

    private func post(alert: [String: Any]) {
        let content = UNMutableNotificationContent()
        content.title = alert["title"] as? String ?? "brainhouse session"
        if let project = alert["project"] as? String { content.subtitle = project }
        let reason = alert["reason"] as? String ?? "awaiting"
        content.body = reason == "turn_complete"
            ? "Turn finished — ready for your next prompt"
            : "Waiting for your input"
        content.sound = .default
        if let guid = alert["iterm_session_id"] as? String { content.userInfo = ["guid": guid] }
        let id = "brainhouse-alert-\(alert["id"] as? Int ?? 0)"
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: id, content: content, trigger: nil))
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
        // Master notifications toggle — flips `notifications.muteAll` on the
        // server, so it silences every channel (this helper AND the web
        // client) and stays in lockstep with the dashboard prefs modal.
        let notifItem = makeItem("Notifications", #selector(toggleNotifications))
        notifItem.state = notificationsEnabled ? .on : .off
        menu.addItem(notifItem)
        if notificationsAuthDenied {
            menu.addItem(infoItem("Notifications blocked in System Settings"))
        }

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

    @objc private func toggleNotifications() {
        var request = URLRequest(url: notificationsToggleURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["enabled": !notificationsEnabled])
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.poll() }
        }.resume()
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

extension AppDelegate: UNUserNotificationCenterDelegate {
    // Click → reveal. `focus` is omitted so the server applies the
    // `notifications.clickFocus` pref (default: raise without stealing
    // keyboard focus). The helper stays pref-ignorant.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        guard let guid = response.notification.request.content.userInfo["guid"] as? String else { return }
        var request = URLRequest(url: revealURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["iterm_session_id": guid])
        URLSession.shared.dataTask(with: request).resume()
    }

    // Post banners even while the helper counts as foreground (accessory
    // apps do, for their own notifications).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
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
