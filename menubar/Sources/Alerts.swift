// Banner delivery for the menu bar helper. Hand-written because the schema
// perch reads cannot say it: a notification fires on a transition rather than
// on a condition holding, and the cursor that makes it fire once is state no
// `when:` can name.
//
// perch never reads or writes this directory. It reaches the emitted app
// through Controller, which declares NSApplicationDelegate and implements none
// of its lifecycle methods — see docs/schema.md in perch.
import AppKit
import UserNotifications

private let port = 8765
private let alertsURL = "http://localhost:\(port)/api/alerts"
private let revealURL = URL(string: "http://localhost:\(port)/api/reveal")!

extension Controller {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AlertDelivery.shared.start()
    }
}

/// The state an extension cannot hold: Swift extensions take no stored
/// properties, so the cursor lives here and the hook above only starts it.
final class AlertDelivery: NSObject {
    static let shared = AlertDelivery()

    // The cursor is seeded silently from the first poll so a helper restart
    // never replays banners the server still holds; the server owns every
    // other decision (grace, dedupe, expiry).
    private var cursor = -1
    private var seeded = false
    private var timer: Timer?

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if !granted { NSLog("brainhouse: notifications not authorized; banners will not appear") }
        }
        // Its own cadence rather than the status item's: this consumes a feed,
        // and perch's poll does not call into hand-written code.
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.fetch() }
        timer?.fire()
    }

    private func fetch() {
        guard let url = URL(string: "\(alertsURL)?after=\(cursor)") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            // Whatever the feed hands over is posted. Muting is decided at
            // enqueue time in alertQueue.ts, so a muted server queues nothing
            // and filtering here would only strand the cursor behind a backlog
            // that then replays on unmute.
            guard let self,
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            DispatchQueue.main.async {
                let alerts = obj["alerts"] as? [[String: Any]] ?? []
                let maxId = alerts.compactMap { $0["id"] as? Int }.max() ?? self.cursor
                if !self.seeded {
                    self.seeded = true
                    self.cursor = maxId
                    return
                }
                for alert in alerts { self.post(alert: alert) }
                self.cursor = max(self.cursor, maxId)
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
}

extension AlertDelivery: UNUserNotificationCenterDelegate {
    // Click → reveal. `focus` is omitted so the server applies the
    // `notifications.clickFocus` pref (default: raise without stealing keyboard
    // focus). The helper stays pref-ignorant.
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

    // Post banners even while the helper counts as foreground (accessory apps
    // do, for their own notifications).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
