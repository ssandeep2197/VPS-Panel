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
        let token = (try? String(contentsOfFile: "\(shots)/token.txt", encoding: .utf8)) ?? ""
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

    /// Signs in with a TMS account through the login screen (the stand-in TMS accepts owner@example.com / pw-owner).
    func testSignsInWithTmsAccount() {
        let app = XCUIApplication()
        app.launchArguments += ["-vps_panel_server", server]
        app.launch()
        let email = app.textFields["Email"].firstMatch
        XCTAssertTrue(email.waitForExistence(timeout: 15), "TMS sign-in form not shown; mode probe failed?")
        sleep(1)
        email.tap()
        email.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 30))
        email.typeText("owner@example.com")
        let password = app.secureTextFields["Password"].firstMatch
        password.tap()
        password.typeText("wrong-password")
        app.buttons["Sign in"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Invalid email or password"].waitForExistence(timeout: 10), "wrong password not reported")
        password.tap()
        password.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20))
        password.typeText("pw-owner")
        snap(app, "4a-before-sign-in")
        app.buttons["Sign in"].firstMatch.tap()
        XCTAssertTrue(app.tabBars.buttons["More"].waitForExistence(timeout: 15), "did not reach the app after TMS sign-in")
        snap(app, "4-tms-signed-in")
        app.tabBars.buttons["More"].tap()
        app.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["owner@example.com"].waitForExistence(timeout: 10), "signed-in email not shown in settings")
        XCTAssertTrue(app.staticTexts["TMS account"].exists)
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
