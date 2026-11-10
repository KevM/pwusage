import Foundation
@testable import PWUsage
import Testing

@Suite("Trmnl device contract")
struct TrmnlDeviceContractTests {
    @Test("Devices decode with their connect date, or none when the server could not date them")
    func decodesDevices() throws {
        let json = """
        {"devices":[
          {"id":2,"uuid":"aaaaaaaa-1111","pluginSettingId":20,"connectedAt":"2026-11-03T15:00:00.000Z"},
          {"id":3,"uuid":"bbbbbbbb-2222","pluginSettingId":30,"connectedAt":null}
        ]}
        """
        let response = try MobileContractDecoder.make().decode(TrmnlDevicesResponse.self, from: Data(json.utf8))
        #expect(response.devices.map(\.id) == [2, 3])
        #expect(response.devices[0].connectedAt == Date(timeIntervalSince1970: 1_793_718_000))
        #expect(response.devices[1].connectedAt == nil)
    }

    @Test("A preview answer without a document still decodes")
    func previewWithoutDocument() throws {
        let response = try JSONDecoder().decode(TrmnlPreviewResponse.self, from: Data(#"{"markup":"<p/>"}"#.utf8))
        #expect(response.document == nil)
    }
}
