import CoreGraphics

/// Where everything goes on the full-screen preview. The preview is the largest 5 by 3 frame that leaves
/// black bars for the controls, so nothing sits on the screen itself and nothing hides: the close button, the
/// previous and next buttons, and the screen's position (dots and caption) all live in the bars. A landscape
/// view puts the buttons in the bars beside the preview; a portrait one puts the navigation in the bar below.
struct TrmnlFullScreenLayout: Equatable {
    static let buttonSize: CGFloat = 44
    static let gap: CGFloat = 12
    /// Room for the position's dots and up to three caption lines.
    static let positionHeight: CGFloat = 76

    struct Insets: Equatable {
        var leading: CGFloat = 0
        var top: CGFloat = 0
        var trailing: CGFloat = 0
        var bottom: CGFloat = 0
    }

    /// The whole screen, safe areas included.
    let container: CGSize
    var safe = Insets()

    private var gap: CGFloat { Self.gap }
    private var button: CGFloat { Self.buttonSize }
    var isLandscape: Bool { container.width > container.height }

    var preview: CGRect {
        let width: CGFloat
        if isLandscape {
            let sideBar = max(safe.leading, safe.trailing) + 2 * gap + button
            width = min(container.width - 2 * sideBar, (container.height - 2 * gap) * TrmnlPreview.aspectRatio)
        } else {
            width = container.width - 2 * gap
        }
        let size = CGSize(width: max(0, width), height: max(0, width / TrmnlPreview.aspectRatio))
        return CGRect(
            x: (container.width - size.width) / 2, y: (container.height - size.height) / 2,
            width: size.width, height: size.height)
    }

    var closeButton: CGRect {
        let left = isLandscape ? leftBarButtonX : safe.leading + gap
        return CGRect(x: left, y: safe.top + gap, width: button, height: button)
    }

    var previousButton: CGRect {
        if isLandscape {
            return CGRect(x: leftBarButtonX, y: container.height / 2 - button / 2, width: button, height: button)
        }
        return CGRect(x: safe.leading + gap, y: bottomBarMidY - button / 2, width: button, height: button)
    }

    var nextButton: CGRect {
        if isLandscape {
            let bar = preview.maxX ... (container.width - safe.trailing)
            return CGRect(
                x: bar.lowerBound + (bar.upperBound - bar.lowerBound - button) / 2,
                y: container.height / 2 - button / 2, width: button, height: button)
        }
        return CGRect(
            x: container.width - safe.trailing - gap - button, y: bottomBarMidY - button / 2,
            width: button, height: button)
    }

    var position: CGRect {
        if isLandscape {
            let left = preview.maxX + gap / 2
            let right = container.width - safe.trailing - gap / 2
            return CGRect(
                x: left, y: container.height - safe.bottom - gap - Self.positionHeight,
                width: max(0, right - left), height: Self.positionHeight)
        }
        let left = previousButton.maxX + gap
        let right = nextButton.minX - gap
        return CGRect(
            x: left, y: bottomBarMidY - Self.positionHeight / 2, width: max(0, right - left),
            height: Self.positionHeight)
    }

    /// The horizontal start of a button centered in the bar left of a landscape preview, beside the island.
    private var leftBarButtonX: CGFloat {
        safe.leading + (preview.minX - safe.leading - button) / 2
    }

    private var bottomBarMidY: CGFloat {
        let top = preview.maxY
        let bottom = container.height - safe.bottom
        return top + (bottom - top) / 2
    }
}
