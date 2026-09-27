import Foundation
import Security

protocol SolcastCredentialKeychain: Sendable {
    func save(key: String, accountScopeID: String, siteID: String, credentialID: String) async throws
    func load(accountScopeID: String, siteID: String) async throws -> SolcastStoredCredential?
    func delete(accountScopeID: String, siteID: String) async throws
    func deleteAll(accountScopeID: String) async throws
    func deleteAllCredentials() async throws
}

struct SolcastStoredCredential: Equatable, Sendable {
    let key: String
    let credentialID: String
}

enum SolarForecastScope {
    static func key(_ accountScopeID: String, _ siteID: String) -> String {
        segment(accountScopeID) + segment(siteID)
    }

    static func prefix(_ accountScopeID: String) -> String { segment(accountScopeID) }

    private static func segment(_ value: String) -> String { "\(value.utf8.count):\(value)" }
}

@MainActor
protocol SolarForecastSessionCleanup {
    func signOut() async throws
}

actor DeviceSolcastCredentialStore: SolcastCredentialKeychain {
    static let shared = DeviceSolcastCredentialStore()
    private let service: String

    init(service: String = Bundle.main.bundleIdentifier ?? "fm.rodeo.pwusage") {
        self.service = service
    }

    func save(key: String, accountScopeID: String, siteID: String, credentialID: String) throws {
        let account = Self.account(accountScopeID: accountScopeID, siteID: siteID)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
            kSecAttrLabel as String: credentialID,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = query
            attributes.forEach { addQuery[$0.key] = $0.value }
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.status(addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError.status(status)
        }
    }

    func load(accountScopeID: String, siteID: String) throws -> SolcastStoredCredential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account(accountScopeID: accountScopeID, siteID: siteID),
            kSecAttrSynchronizable as String: false,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let attributes = result as? [String: Any],
              let data = attributes[kSecValueData as String] as? Data,
              let value = String(data: data, encoding: .utf8),
              let credentialID = attributes[kSecAttrLabel as String] as? String else {
            throw KeychainError.invalidItem
        }
        return SolcastStoredCredential(key: value, credentialID: credentialID)
    }

    func delete(accountScopeID: String, siteID: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account(accountScopeID: accountScopeID, siteID: siteID),
            kSecAttrSynchronizable as String: false,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }

    func deleteAll(accountScopeID: String) throws {
        // The app owns a single generic-password service. Its nonsecret metadata
        // contains no secrets; delete matching items by their account prefix.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: false,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { throw KeychainError.status(status) }
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String,
                  account.hasPrefix(Self.scopePrefix(accountScopeID)) else { continue }
            let itemQuery: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecAttrSynchronizable as String: false,
            ]
            let deleteStatus = SecItemDelete(itemQuery as CFDictionary)
            guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else { throw KeychainError.status(deleteStatus) }
        }
    }

    func deleteAllCredentials() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: false,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }

    private static func account(accountScopeID: String, siteID: String) -> String { SolarForecastScope.key(accountScopeID, siteID) }

    private static func scopePrefix(_ accountScopeID: String) -> String { SolarForecastScope.prefix(accountScopeID) }

    enum KeychainError: Error { case status(OSStatus), invalidItem }
}
