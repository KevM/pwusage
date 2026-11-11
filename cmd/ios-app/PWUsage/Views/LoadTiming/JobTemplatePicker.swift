import SwiftUI

/// The list shown by "Add a Job"; choosing a template opens the editor on its draft.
struct JobTemplatePicker: View {
    let onChoose: (ProfileDraft) -> Void

    var body: some View {
        List(JobTemplates.all) { template in
            Button {
                onChoose(template.draft)
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(template.title).foregroundStyle(.primary)
                        Text(template.subtitle).font(.footnote).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: template.symbol).foregroundStyle(.tint)
                }
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(template.title), \(template.subtitle)")
        }
        .navigationTitle("Add a Job")
        .navigationBarTitleDisplayMode(.inline)
    }
}
