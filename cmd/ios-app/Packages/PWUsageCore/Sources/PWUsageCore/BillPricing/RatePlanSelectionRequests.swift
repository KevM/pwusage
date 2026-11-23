import Foundation

// Request side of the rate plan selection contract. Mirrors `TariffSelectionRequest` and
// `TariffSelectionCommit` in `cmd/next-app/src/lib/tariff-contract.ts`.

/// Which timeline a selection changes: the plan that prices energy, or the comparison plan.
public enum TariffSelectionScope: String, Codable, Equatable, Sendable {
    case actual
    case reference
}

/// The plan an owner wants to apply. The app never sends published rates for a public plan;
/// the server resolves the label itself.
public enum TariffSelectionCandidate: Encodable, Equatable, Sendable {
    case publicPlan(label: String)
    case manual(name: String, seasons: [TariffSeasonInput])
    case restoreTesla(originalSelectionID: Int)

    private enum CodingKeys: String, CodingKey { case kind, label, name, seasons, originalSelectionId }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .publicPlan(let label):
            try container.encode("public", forKey: .kind)
            try container.encode(label, forKey: .label)
        case .manual(let name, let seasons):
            try container.encode("manual", forKey: .kind)
            try container.encode(name, forKey: .name)
            try container.encode(seasons, forKey: .seasons)
        case .restoreTesla(let originalSelectionID):
            try container.encode("restore_tesla", forKey: .kind)
            try container.encode(originalSelectionID, forKey: .originalSelectionId)
        }
    }
}

/// The dates are always explicit: `effectiveTo == nil` means ongoing, and is sent as `null`.
public struct TariffSelectionRequest: Encodable, Equatable, Sendable {
    public let scope: TariffSelectionScope
    public let candidate: TariffSelectionCandidate
    public let effectiveFrom: String
    public let effectiveTo: String?

    public init(
        scope: TariffSelectionScope,
        candidate: TariffSelectionCandidate,
        effectiveFrom: String,
        effectiveTo: String?
    ) {
        self.scope = scope
        self.candidate = candidate
        self.effectiveFrom = effectiveFrom
        self.effectiveTo = effectiveTo
    }

    private enum CodingKeys: String, CodingKey { case scope, candidate, effectiveFrom, effectiveTo }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(scope, forKey: .scope)
        try container.encode(candidate, forKey: .candidate)
        try container.encode(effectiveFrom, forKey: .effectiveFrom)
        try container.encode(effectiveTo, forKey: .effectiveTo)
    }
}

/// Applies a reviewed selection. `expectedReviewHash` comes from the preview the owner saw;
/// bill verification is a separate, explicit choice.
public struct TariffSelectionCommit: Encodable, Equatable, Sendable {
    public let request: TariffSelectionRequest
    let expectedReviewHash: String
    public let verifiedAgainstBill: Bool

    public init(request: TariffSelectionRequest, expectedReviewHash: String, verifiedAgainstBill: Bool) {
        self.request = request
        self.expectedReviewHash = expectedReviewHash
        self.verifiedAgainstBill = verifiedAgainstBill
    }

    private enum CodingKeys: String, CodingKey { case expectedReviewHash, verifiedAgainstBill }

    public func encode(to encoder: Encoder) throws {
        try request.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expectedReviewHash, forKey: .expectedReviewHash)
        try container.encode(verifiedAgainstBill, forKey: .verifiedAgainstBill)
    }
}

public struct TariffAiHandoffPreviewRequest: Encodable, Equatable, Sendable {
    let rawInput: String

    public init(rawInput: String) {
        self.rawInput = rawInput
    }
}

public struct TariffAiHandoffCommitRequest: Encodable, Equatable, Sendable {
    let rawInput: String
    let expectedReviewHash: String
    let verifiedAgainstBill: Bool

    public init(rawInput: String, expectedReviewHash: String, verifiedAgainstBill: Bool) {
        self.rawInput = rawInput
        self.expectedReviewHash = expectedReviewHash
        self.verifiedAgainstBill = verifiedAgainstBill
    }
}
