import Testing

/// Shared bounded waits for asynchronous tests. Never assert after a fixed sleep:
/// wait for the state that proves the work ran, or hold an invariant for a window.
struct WaitTimeout: Error { let message: String }
struct InvariantBroken: Error { let message: String }

/// Polls until `condition` is true, failing at the deadline instead of hanging.
@MainActor
func eventually(
    timeout: Duration = .seconds(2),
    _ condition: @MainActor () -> Bool
) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    if condition() { return }
    throw WaitTimeout(message: "Timed out after \(timeout) waiting for condition")
}

/// The inverse of `eventually`: polls for the whole window and fails the moment
/// `condition` stops holding, so "nothing else happened" is checked throughout the
/// window rather than at one instant after a sleep.
@MainActor
func staysTrue(
    for window: Duration = .milliseconds(100),
    _ condition: @MainActor () -> Bool
) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: window)
    repeat {
        guard condition() else {
            throw InvariantBroken(message: "Condition stopped holding within \(window)")
        }
        try await Task.sleep(for: .milliseconds(5))
    } while clock.now < deadline
    guard condition() else {
        throw InvariantBroken(message: "Condition stopped holding within \(window)")
    }
}

@MainActor
@Suite("Test wait helpers")
struct TestWaitTests {
    @Test("eventually fails rather than returning after its deadline")
    func eventuallyTimesOut() async {
        await #expect(throws: WaitTimeout.self) {
            try await eventually(timeout: .milliseconds(50)) { false }
        }
    }

    @Test("staysTrue fails as soon as the invariant breaks inside the window")
    func staysTrueDetectsChange() async {
        var calls = 0
        await #expect(throws: InvariantBroken.self) {
            try await staysTrue(for: .seconds(2)) {
                calls += 1
                return calls < 3
            }
        }
        #expect(calls == 3)
    }

    @Test("staysTrue returns once the window passes with the invariant intact")
    func staysTrueHolds() async throws {
        try await staysTrue(for: .milliseconds(20)) { true }
    }
}
