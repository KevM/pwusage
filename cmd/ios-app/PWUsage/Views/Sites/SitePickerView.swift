import SwiftUI

struct SitePickerView: View {
    @Environment(\.dismiss) private var dismiss
    let sites: [MobileSite]
    let selectedSiteID: String
    let onSelect: (MobileSite) -> Void

    var body: some View {
        NavigationStack {
            List(sites) { site in
                Button { onSelect(site) } label: {
                    HStack(spacing: 13) {
                        Image(systemName: "house.fill")
                            .foregroundStyle(.green)
                            .frame(width: 30)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(site.name).font(.body.weight(.semibold)).foregroundStyle(.primary)
                            Text(site.utility).font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if site.id == selectedSiteID {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .accessibilityLabel("Selected")
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect()
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(site.id == selectedSiteID ? .isSelected : [])
            }
            .navigationTitle("Choose a Site")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                    .keyboardShortcut(.cancelAction)
                }
            }
        }
    }
}
