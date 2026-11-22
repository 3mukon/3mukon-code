// Install cleanup as soon as an input-down is dispatched. Both key and pointer holds use this
// boundary, so cancellation before a hold leaves input alone and cancellation during it releases it.
@MainActor
func withHeldInput(
    down: () -> Void, up: () -> Void, whileHeld: () async throws -> Void
) async throws {
    try Task.checkCancellation()
    down()
    defer { up() }
    try await whileHeld()
}
