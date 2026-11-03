import XCTest

/// Drives the real app against a local panel server. The token and server come from the scratchpad
/// so the test never needs the production password.
final class SitesNavigationTests: XCTestCase {
    /// Directory holding token.txt (a panel JWT) and receiving screenshots. Pass it as a build setting:
    /// xcodebuild test ... VPS_PANEL_TEST_DIR=/path VPS_PANEL_TEST_SERVER=http://127.0.0.1:4601 (see project.yml).
    private static func env(_ name: String) -> String? {
        let v = ProcessInfo.processInfo.environment[name] ?? ""
        return v.isEmpty ? nil : v
    }
    private let shots = SitesNavigationTests.env("VPS_PANEL_TEST_DIR") ?? NSTemporaryDirectory()
    private let server = SitesNavigationTests.env("VPS_PANEL_TEST_SERVER") ?? "http://127.0.0.1:4601"

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        let token = ((try? String(contentsOfFile: "\(shots)/token.txt", encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        app.launchEnvironment["VPS_PANEL_TOKEN"] = token
        app.launchArguments += ["-vps_panel_server", server]
        app.launch()
        return app
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? png.write(to: URL(fileURLWithPath: "\(shots)/ui-\(name).png"))
    }

    func testOpensSiteDetailFromMore() {
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["More"].waitForExistence(timeout: 15))
        app.tabBars.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Sites"].firstMatch.waitForExistence(timeout: 10) || app.staticTexts["Sites"].firstMatch.waitForExistence(timeout: 2))
        (app.buttons["Sites"].firstMatch.exists ? app.buttons["Sites"].firstMatch : app.staticTexts["Sites"].firstMatch).tap()
        XCTAssertTrue(app.navigationBars["Sites"].waitForExistence(timeout: 10), "Sites list did not open")
        let row = app.staticTexts["rubik.helloworlds.co.in"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "site row not shown")
        snap(app, "1-list")
        row.tap()
        sleep(2)
        snap(app, "2-after-tap")
        let detailOpened = app.staticTexts["Why it is not working"].exists || app.staticTexts["Response"].waitForExistence(timeout: 5)
        XCTAssertTrue(detailOpened, "detail screen did not open; nav bars: \(app.navigationBars.allElementsBoundByIndex.map { $0.identifier })")
        XCTAssertFalse(app.navigationBars["Sites"].exists, "still on the Sites list")
    }

    /// Signs in with TMS: the login screen opens the TMS sign-in page in a browser sheet (the stand-in provider
    /// accepts owner@example.com / pw-owner) and the server hands the session back through vpspanel://signed-in.
    func testSignsInWithTmsAccount() {
        let app = XCUIApplication()
        app.launchArguments += ["-vps_panel_server", server, "-vps_panel_signed_out"]
        app.launch()
        let button = app.buttons["Sign in with HW"].firstMatch
        let shown = button.waitForExistence(timeout: 15)
        if !shown { snap(app, "4z-no-button") }
        XCTAssertTrue(shown, "TMS sign-in button not shown; mode probe failed?")
        snap(app, "4a-login")
        button.tap()
        // iOS asks once whether the app may use the server's host to sign in
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let consent = springboard.buttons["Continue"].firstMatch
        if consent.waitForExistence(timeout: 8) { consent.tap() }
        let email = app.webViews.textFields.firstMatch
        let tabs = app.tabBars.buttons["More"]
        // Within 8 hours of an earlier sign-in the TMS signs in silently (its tms_idp cookie), so either the
        // sign-in page or the app itself may appear here
        let deadline = Date().addingTimeInterval(20)
        while !email.exists && !tabs.exists && Date() < deadline { usleep(300_000) }
        if email.exists {
            snap(app, "4b-tms-page")
            email.tap()
            email.typeText("owner@example.com")
            let password = app.webViews.secureTextFields.firstMatch
            password.tap()
            // Return submits the form; the keyboard's accessory bar would otherwise cover the page's button
            password.typeText("wrong-password\n")
            snap(app, "4c-filled")
            sleep(2)
            snap(app, "4d-after-wrong")
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Invalid email or password")).firstMatch.waitForExistence(timeout: 10), "wrong password not reported on the TMS page")
            let password2 = app.webViews.secureTextFields.firstMatch
            password2.tap()
            password2.typeText("pw-owner\n")
            sleep(2)
            snap(app, "4e-after-right")
        } else {
            snap(app, "4b-silent-sign-in")
        }
        XCTAssertTrue(app.tabBars.buttons["More"].waitForExistence(timeout: 20), "did not reach the app after the TMS sign-in")
        snap(app, "4-tms-signed-in")
        app.tabBars.buttons["More"].tap()
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["owner@example.com"].waitForExistence(timeout: 10), "signed-in email not shown in settings")
        XCTAssertTrue(app.staticTexts["HW account"].exists)
        XCTAssertTrue(app.staticTexts["owner"].exists, "role not shown")
        snap(app, "5-settings")
    }

    func testOpensSiteDetailFromDashboard() {
        let app = launch()
        let card = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'sites working'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20), "dashboard sites card missing")
        card.tap()
        XCTAssertTrue(app.navigationBars["Sites"].waitForExistence(timeout: 10))
        let row = app.staticTexts["tms.helloworlds.co.in"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        row.tap()
        sleep(2)
        snap(app, "3-dashboard-path")
        XCTAssertTrue(app.staticTexts["Response"].waitForExistence(timeout: 5), "detail did not open from dashboard path")
    }
}
