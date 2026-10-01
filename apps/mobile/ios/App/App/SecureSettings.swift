import Foundation
import Capacitor
import Security

@objc(SecureSettingsPlugin)
public class SecureSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureSettingsPlugin"
    public let jsName = "SecureSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSyncUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSyncUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSecret", returnType: CAPPluginReturnPromise)
    ]

    private let account = "sync_url"
    private var service: String { Bundle.main.bundleIdentifier ?? "com.zmarn.once" }

    @objc func getSyncUrl(_ call: CAPPluginCall) {
        readItem(call, account: account)
    }

    @objc func setSyncUrl(_ call: CAPPluginCall) {
        writeItem(call, account: account, value: call.getString("value") ?? "")
    }

    /// Source tokens share the Keychain service with the sync URL, under
    /// their own accounts, so they get the same protection and the same
    /// device-only accessibility.
    @objc func getSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A secret needs a key")
            return
        }
        readItem(call, account: "secret." + key)
    }

    @objc func setSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A secret needs a key")
            return
        }
        writeItem(call, account: "secret." + key, value: call.getString("value") ?? "")
    }

    private func readItem(_ call: CAPPluginCall, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["value": ""])
            return
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Unable to read secure settings")
            return
        }
        call.resolve(["value": value])
    }

    private func writeItem(_ call: CAPPluginCall, account: String, value: String) {
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(match as CFDictionary)
        if value.isEmpty {
            call.resolve()
            return
        }
        var item = match
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            call.reject("Unable to save secure settings")
            return
        }
        call.resolve()
    }
}
