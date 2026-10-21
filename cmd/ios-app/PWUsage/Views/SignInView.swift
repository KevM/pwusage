import SwiftUI

struct SignInView: View {
    let isWorking: Bool
    let message: String?
    let onSignIn: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 24) {
                    brandMark
                    heading
                    if let message {
                        errorCard(message)
                    }
                    signInButton
                    legalLinks
                    trustNote
                }
                .frame(maxWidth: 460)
                .padding(.horizontal, 28)
                .padding(.vertical, 32)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .center)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.hidden)
        }
        .background { screenBackground }
    }

    private var brandMark: some View {
        Image("PWUsageLogo")
            .resizable()
            .scaledToFit()
            .frame(width: 96, height: 96)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(.primary.opacity(colorScheme == .dark ? 0.10 : 0.08), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.16), radius: 12, y: 6)
            .accessibilityHidden(true)
    }

    private var heading: some View {
        VStack(spacing: 10) {
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
    }

    private func errorCard(_ message: String) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    errorIcon
                    errorText(message)
                }
            } else {
                HStack(alignment: .top, spacing: 10) {
                    errorIcon
                    errorText(message)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.red.opacity(0.20), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var errorIcon: some View {
        Image(systemName: "exclamationmark.circle.fill")
            .foregroundStyle(.red)
            .accessibilityHidden(true)
    }

    private func errorText(_ message: String) -> some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.primary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var signInButton: some View {
        Button(action: onSignIn) {
            HStack(spacing: 10) {
                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                        .tint(buttonForeground)
                }
                Text(isWorking ? "Connecting…" : "Sign in")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(buttonForeground)
            .background(buttonBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(SignInButtonStyle())
        .shadow(color: buttonBackground.opacity(0.18), radius: 12, y: 6)
        .disabled(isWorking)
        .hoverEffect()
        .accessibilityHint("Opens the pwusage secure sign-in page")
    }

    private var legalLinks: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                privacyLink
                Text("·")
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
                supportLink
            }
            VStack(spacing: 4) {
                privacyLink
                supportLink
            }
        }
        .font(.footnote)
    }

    private var privacyLink: some View {
        Link(destination: AppConfiguration.defaultAPIOrigin.appendingPathComponent("privacy")) {
            Text("Privacy Policy")
                .padding(.horizontal, 10)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
    }

    private var supportLink: some View {
        Link(destination: AppConfiguration.defaultAPIOrigin.appendingPathComponent("support")) {
            Text("Support")
                .padding(.horizontal, 10)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
    }

    private var trustNote: some View {
        Text("Your Tesla password stays with Tesla. This app uses a secure sign-in session.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var screenBackground: some View {
        SectionTheme.groupedBackground
            .overlay(alignment: .topLeading) {
                Circle()
                    .fill(accent.opacity(colorScheme == .dark ? 0.14 : 0.08))
                    .frame(width: 340, height: 340)
                    .blur(radius: 50)
                    .offset(x: -110, y: -130)
            }
            .ignoresSafeArea()
    }

    private var accent: Color {
        colorScheme == .dark
            ? Color(red: 0.47, green: 0.90, blue: 0.65)
            : Color(red: 0.05, green: 0.38, blue: 0.22)
    }

    private var buttonBackground: Color {
        colorScheme == .dark
            ? accent
            : Color(red: 0.03, green: 0.32, blue: 0.18)
    }

    private var buttonForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.02, green: 0.15, blue: 0.08)
            : .white
    }
}

private struct SignInButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.88 : 1)
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

#Preview("Sign in") {
    SignInView(isWorking: false, message: nil, onSignIn: {})
}

#Preview("Sign in · Connecting") {
    SignInView(isWorking: true, message: nil, onSignIn: {})
}

#Preview("Sign in · Error") {
    SignInView(
        isWorking: false,
        message: "Your session expired. Sign in to continue.",
        onSignIn: {}
    )
}

#Preview("Sign in · Dark") {
    SignInView(isWorking: false, message: nil, onSignIn: {})
        .preferredColorScheme(.dark)
}

#Preview("Sign in · Accessibility") {
    SignInView(
        isWorking: false,
        message: "Your session expired. Sign in to continue.",
        onSignIn: {}
    )
    .environment(\.dynamicTypeSize, .accessibility3)
}

#Preview("Sign in · Small screen") {
    SignInView(
        isWorking: false,
        message: "Your session expired. Sign in to continue.",
        onSignIn: {}
    )
    .frame(width: 320, height: 568)
}
