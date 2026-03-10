import XCTest
import CoreGraphics
@testable import ClaudeInSafari

// MARK: - Mock provider

private class MockCaptureProvider: ScreenCaptureProvider {
    var permissionGranted = true
    // Viewport matches image dimensions (100×100) so pixelScale = 1.0 in zoom tests.
    var captureResult: Result<(CGImage, Int, Int), ScreenshotError> = .success((MockCaptureProvider.makeTestImage(), 100, 100))

    static func makeTestImage(width: Int = 100, height: Int = 100) -> CGImage {
        let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        return ctx.makeImage()!
    }

    func checkPermission() -> Bool { permissionGranted }

    func captureWindow(completion: @escaping (Result<(CGImage, Int, Int), ScreenshotError>) -> Void) {
        completion(captureResult)
    }
}

// MARK: - Tests

final class ScreenshotServiceTests: XCTestCase {

    private var mock: MockCaptureProvider!
    private var service: ScreenshotService!

    override func setUp() {
        super.setUp()
        mock = MockCaptureProvider()
        service = ScreenshotService(captureProvider: mock)
    }

    // MARK: - T4: zoom without region

    func testZoomWithoutRegionFails() {
        let exp = expectation(description: "zoom without region")
        service.captureZoom(tabId: nil, region: nil) { result in
            if case .failure(.invalidRegion(let msg)) = result {
                XCTAssertTrue(msg.contains("required"), "Error should say 'required', got: \(msg)")
                exp.fulfill()
            } else {
                XCTFail("Expected invalidRegion, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - T13: inverted region (x0 >= x1 or y0 >= y1)

    func testZoomInvertedRegionFails() {
        let exp = expectation(description: "inverted region")
        service.captureZoom(tabId: nil, region: [500, 500, 100, 100]) { result in
            if case .failure(.invalidRegion) = result {
                exp.fulfill()
            } else {
                XCTFail("Expected invalidRegion, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    func testZoomEqualCoordinatesFails() {
        let exp = expectation(description: "equal coordinates")
        service.captureZoom(tabId: nil, region: [100, 100, 100, 100]) { result in
            if case .failure(.invalidRegion) = result {
                exp.fulfill()
            } else {
                XCTFail("Expected invalidRegion, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - T5: zoom region out of bounds

    func testZoomRegionOutOfBoundsFails() {
        let exp = expectation(description: "out of bounds region")
        // Mock viewport is 100×100; region extends far beyond that
        service.captureZoom(tabId: nil, region: [0, 0, 99999, 99999]) { result in
            if case .failure(.invalidRegion) = result {
                exp.fulfill()
            } else {
                XCTFail("Expected invalidRegion, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - T6: Screen Recording permission denied

    func testScreenshotPermissionDenied() {
        mock.permissionGranted = false
        let exp = expectation(description: "permission denied")
        service.captureScreenshot(tabId: nil) { result in
            if case .failure(.permissionDenied) = result {
                exp.fulfill()
            } else {
                XCTFail("Expected permissionDenied, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    func testZoomPermissionDenied() {
        mock.permissionGranted = false
        let exp = expectation(description: "zoom permission denied")
        service.captureZoom(tabId: nil, region: [0, 0, 100, 100]) { result in
            if case .failure(.permissionDenied) = result {
                exp.fulfill()
            } else {
                XCTFail("Expected permissionDenied, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - T7: no Safari window

    func testNoSafariWindowError() {
        mock.captureResult = .failure(.noSafariWindow)
        let exp = expectation(description: "no Safari window")
        service.captureScreenshot(tabId: nil) { result in
            if case .failure(.noSafariWindow) = result {
                exp.fulfill()
            } else {
                XCTFail("Expected noSafariWindow, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - T8: imageId stored in CapturedImage

    func testScreenshotStoresImageId() {
        let exp = expectation(description: "imageId stored")
        var capturedId: String?
        service.captureScreenshot(tabId: nil) { result in
            if case .success(let img) = result {
                capturedId = img.imageId
                exp.fulfill()
            } else {
                XCTFail("Expected success, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
        guard let id = capturedId else { return XCTFail("No imageId") }
        XCTAssertNotNil(service.retrieveImage(imageId: id), "Retrieved image should not be nil")
        XCTAssertNotNil(UUID(uuidString: id), "imageId should be a valid UUID")
    }

    // MARK: - T9: 51st screenshot evicts oldest

    func testStorageEvictsOldestAt51() {
        var firstId: String?
        for i in 0..<51 {
            let exp = expectation(description: "capture \(i)")
            service.captureScreenshot(tabId: nil) { result in
                if case .success(let img) = result {
                    if i == 0 { firstId = img.imageId }
                }
                exp.fulfill()
            }
        }
        waitForExpectations(timeout: 5)
        XCTAssertEqual(service.imageCount, 50, "Storage should cap at 50 images")
        if let id = firstId {
            XCTAssertNil(service.retrieveImage(imageId: id), "Oldest image should be evicted after 51st capture")
        }
    }

    // MARK: - T12: minimum valid zoom region

    func testZoomMinimumRegionSucceeds() {
        let exp = expectation(description: "minimum zoom")
        service.captureZoom(tabId: nil, region: [0, 0, 10, 10]) { result in
            if case .success(let img) = result {
                XCTAssertFalse(img.data.isEmpty, "Image data should not be empty")
                exp.fulfill()
            } else {
                XCTFail("Expected success, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - Result data is valid PNG

    func testScreenshotReturnsPNGData() {
        let exp = expectation(description: "PNG data")
        service.captureScreenshot(tabId: nil) { result in
            if case .success(let img) = result {
                // PNG magic bytes: 0x89 0x50 0x4E 0x47
                let bytes = [UInt8](img.data.prefix(4))
                XCTAssertEqual(bytes, [0x89, 0x50, 0x4E, 0x47], "Data should start with PNG magic bytes")
                exp.fulfill()
            } else {
                XCTFail("Expected success, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - retrieveImage returns nil for unknown id

    func testRetrieveUnknownImageReturnsNil() {
        XCTAssertNil(service.retrieveImage(imageId: "does-not-exist"))
    }

    // MARK: - Capture failure propagates

    func testCaptureFailedPropagates() {
        mock.captureResult = .failure(.captureFailed("test error"))
        let exp = expectation(description: "capture failed")
        service.captureScreenshot(tabId: nil) { result in
            if case .failure(.captureFailed(let msg)) = result {
                XCTAssertEqual(msg, "test error")
                exp.fulfill()
            } else {
                XCTFail("Expected captureFailed, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - Viewport dimensions are stored

    func testViewportDimensionsStoredCorrectly() {
        let exp = expectation(description: "viewport dims")
        service.captureScreenshot(tabId: nil) { result in
            if case .success(let img) = result {
                XCTAssertEqual(img.viewportWidth, 100)
                XCTAssertEqual(img.viewportHeight, 100)
                exp.fulfill()
            } else {
                XCTFail("Expected success, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - Zoom success returns image with region dimensions

    func testZoomSuccessReturnsCroppedDimensions() {
        let exp = expectation(description: "zoom success")
        // Region fits within the 100×100 mock viewport.
        service.captureZoom(tabId: nil, region: [0, 0, 50, 50]) { result in
            if case .success(let img) = result {
                XCTAssertEqual(img.viewportWidth, 50)
                XCTAssertEqual(img.viewportHeight, 50)
                exp.fulfill()
            } else {
                XCTFail("Expected success, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - T17: zoom image is stored and retrievable

    func testZoomStoresImageId() {
        let exp = expectation(description: "zoom stores imageId")
        var capturedId: String?
        service.captureZoom(tabId: nil, region: [0, 0, 50, 50]) { result in
            if case .success(let img) = result {
                capturedId = img.imageId
                exp.fulfill()
            } else {
                XCTFail("Expected success, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
        guard let id = capturedId else { return XCTFail("No imageId from zoom") }
        XCTAssertNotNil(service.retrieveImage(imageId: id), "Zoom image should be stored and retrievable")
        XCTAssertNotNil(UUID(uuidString: id), "Zoom imageId should be a valid UUID")
    }

    // MARK: - Negative coordinates fail before capture

    func testZoomNegativeCoordinatesFails() {
        let exp = expectation(description: "negative coordinates")
        service.captureZoom(tabId: nil, region: [-10, -10, 100, 100]) { result in
            if case .failure(.invalidRegion) = result {
                exp.fulfill()
            } else {
                XCTFail("Expected invalidRegion, got \(result)")
            }
        }
        waitForExpectations(timeout: 1)
    }

    // MARK: - Multiple captures produce unique imageIds

    func testCapturesProduceUniqueIds() {
        var ids: [String] = []
        for i in 0..<3 {
            let exp = expectation(description: "capture \(i)")
            service.captureScreenshot(tabId: nil) { result in
                if case .success(let img) = result { ids.append(img.imageId) }
                exp.fulfill()
            }
        }
        waitForExpectations(timeout: 1)
        XCTAssertEqual(Set(ids).count, 3, "All imageIds should be unique")
    }
}
