import XCTest

/// Drives the real app against a local panel server. The token and server come from the scratchpad
/// so the test never needs the production password.
final class SitesNavigationTests: XCTestCase {
    /// Directory holding token.txt (a panel JWT) and receiving screenshots. Pass it with
    /// TEST_RUNNER_VPS_PANEL_TEST_DIR=/path xcodebuild test ...; the server URL with TEST_RUNNER_VPS_PANEL_TEST_SERVER.
    private let shots = ProcessInfo.processInfo.environment["VPS_PANEL_TEST_DIR"] ?? NSTemporaryDirectory()
    private let server = ProcessInfo.processInfo.environment["VPS_PANEL_TEST_SERVER"] ?? "http://127.0.0.1:4601"

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
