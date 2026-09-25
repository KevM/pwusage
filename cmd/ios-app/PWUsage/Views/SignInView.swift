import SwiftUI

struct SignInView: View {
    let isWorking: Bool
    let message: String?
    let onSignIn: () -> Void

    var body: some View {
        VStack(spacing: 26) {
            Spacer()
            ZStack {
                RoundedRectangle(cornerRadius: 30, style: .continuous)
                    .fill(LinearGradient(colors: [.green.opacity(0.18), .teal.opacity(0.12)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 112, height: 112)
                Image(systemName: "bolt.house.fill")
                    .font(.system(size: 48, weight: .semibold))
                    .foregroundStyle(.green)
            }
            VStack(spacing: 9) {
                Text("Your energy, at a glance")
                    .font(.largeTitle.weight(.bold))
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text("Sign in to view live home power and your current bill.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            Button(action: onSignIn) {
                HStack(spacing: 10) {
                    if isWorking { ProgressView().tint(.white) }
                    Text(isWorking ? "Connecting…" : "Sign in")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                .foregroundStyle(.white)
                .background(Color.green.gradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .disabled(isWorking)
            .hoverEffect()
            .accessibilityHint("Opens the pwusage secure sign-in page")
            Spacer()
            Text("Your password stays with pwusage. This app uses a secure sign-in session.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.bottom, 10)
        }
        .padding(28)
        .frame(maxWidth: 500)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
    }
}
