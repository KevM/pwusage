@testable import PWUsage
import Testing

@Suite("Sync to Tesla sending status")
struct TeslaSyncSendingStatusTests {
    @Test("The first seconds say the plan is being sent")
    func sendingFirst() {
        #expect(TeslaSyncCopy.sendingStatus(afterSeconds: 0) == "Sending your plan to Tesla…")
        #expect(TeslaSyncCopy.sendingStatus(afterSeconds: 3.9) == "Sending your plan to Tesla…")
    }

    @Test("After the write, it says PWUsage is waiting for Tesla to confirm and how long that can take")
    func waitingAfter() {
        let waiting = "Waiting for Tesla to confirm. This can take up to 20 seconds."
        #expect(TeslaSyncCopy.sendingStatus(afterSeconds: 4) == waiting)
        #expect(TeslaSyncCopy.sendingStatus(afterSeconds: 30) == waiting)
    }
}
