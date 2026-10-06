import UIKit
import Capacitor

/// Native browser sheet: Back, Forward, Reload and Find above the shell's
/// rows (add-on trays for the open page), matching Android's NativeBrowserMenu.
final class BrowserMenuSheet: UIViewController, UIAdaptivePresentationControllerDelegate {
    /// The sheet's colours, mirroring the shell's CSS theme tokens so the sheet
    /// reads as part of the app rather than a system sheet laid over it.
    private struct Palette {
        let sheet, card, text, muted, icon, pressed: UIColor

        init(dark: Bool) {
            func rgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> UIColor {
                UIColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
            }
            sheet = dark ? rgb(40, 42, 54) : rgb(246, 246, 239)
            card = dark ? rgb(56, 58, 89) : .white
            text = dark ? rgb(188, 194, 205) : rgb(39, 38, 54)
            muted = dark ? rgb(120, 126, 142) : rgb(150, 149, 159)
            icon = dark ? rgb(188, 194, 205) : rgb(105, 104, 121)
            pressed = dark ? UIColor(white: 1, alpha: 0.16) : UIColor(red: 70 / 255, green: 60 / 255, blue: 110 / 255, alpha: 0.1)
        }
    }

    struct Navigation {
        let canBack, canForward, canReload: Bool
        let back, forward, reload: () -> Void
    }

    private let call: CAPPluginCall
    private let navigation: Navigation
    private let keepsMedia: Bool
    private let keepMedia: (Bool) -> Void
    private let palette: Palette
    private var settled = false
    private var chosen: String?
    private var fittedHeight: CGFloat = 0
    private let content = UIStackView()

    init(call: CAPPluginCall, navigation: Navigation, keepsMedia: Bool, dark: Bool, keepMedia: @escaping (Bool) -> Void) {
        self.call = call
        self.navigation = navigation
        self.keepsMedia = keepsMedia
        self.keepMedia = keepMedia
        palette = Palette(dark: dark)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        overrideUserInterfaceStyle = dark ? .dark : .light
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    /// Resolves the shell's call once: with the chosen id, or empty when the
    /// sheet closes without one (a native control already ran, or nothing).
    private func settle(_ id: String?) {
        guard !settled else { return }
        settled = true
        if let id { call.resolve(["id": id]) } else { call.resolve() }
    }

    /// Resolves once the sheet is gone: the shell may present a menu of its
    /// own for the choice ("Send page to device…"), which UIKit drops while
    /// this sheet is still dismissing.
    private func choose(_ id: String) {
        chosen = id
        dismiss(animated: true) { self.settle(id) }
    }

    private func run(_ action: @escaping () -> Void) {
        settle(nil)
        dismiss(animated: true)
        action()
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        settle(nil)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // A chosen row settles in its dismiss completion, which runs after this.
        if chosen == nil { settle(nil) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = palette.sheet
        presentationController?.delegate = self
        let scroll = UIScrollView()
        scroll.alwaysBounceVertical = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        content.axis = .vertical
        content.spacing = 8
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            // Room for the grabber above, the home indicator below.
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 28),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -16),
            content.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -16)
        ])

        let navigation = self.navigation
        let controls = UIStackView(arrangedSubviews: [
            tile("chevron.backward", "Back", navigation.canBack) { [weak self] in self?.run(navigation.back) },
            tile("chevron.forward", "Forward", navigation.canForward) { [weak self] in self?.run(navigation.forward) },
            tile("arrow.clockwise", "Reload", navigation.canReload) { [weak self] in self?.run(navigation.reload) },
            // The shell's find flow answers this: the reader's bar, or the
            // system find panel over the page.
            tile("magnifyingglass", "Find", true) { [weak self] in self?.choose("once:find") }
        ])
        controls.axis = .horizontal
        controls.distribution = .fillEqually
        controls.spacing = 8
        content.addArrangedSubview(controls)
        content.addArrangedSubview(toggle("Keep media playing in background", isOn: keepsMedia, changed: keepMedia))

        for item in call.getArray("items", JSObject.self) ?? [] {
            guard let id = item["id"] as? String, let label = item["label"] as? String else { continue }
            content.addArrangedSubview(entry(
                id: id,
                label: label,
                enabled: item["enabled"] as? Bool ?? true,
                iconDataUrl: item["iconDataUrl"] as? String,
                settingsId: item["settingsId"] as? String
            ))
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        fitSheetToContent()
    }

    /// The sheet takes the height its rows need, up to the large detent.
    private func fitSheetToContent() {
        guard #available(iOS 16.0, *), let sheet = sheetPresentationController else { return }
        let height = content.systemLayoutSizeFitting(
            CGSize(width: view.bounds.width - 32, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        ).height + 44
        guard abs(fittedHeight - height) >= 1 else { return }
        fittedHeight = height
        sheet.animateChanges {
            sheet.detents = [.custom(identifier: .init("once.browser-menu")) { context in
                min(height, context.maximumDetentValue)
            }, .large()]
        }
    }

    /// Detents and grabber; called before presentation.
    func configureSheet() {
        guard let sheet = sheetPresentationController else { return }
        sheet.prefersGrabberVisible = true
        sheet.preferredCornerRadius = 32
        sheet.detents = [.medium(), .large()]
        sheet.prefersScrollingExpandsWhenScrolledToEdge = false
    }

    private func button(enabled: Bool, action: @escaping () -> Void) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.baseForegroundColor = enabled ? palette.text : palette.muted
        configuration.background.backgroundColor = palette.card
        configuration.background.cornerRadius = 12
        let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        let palette = self.palette
        button.configurationUpdateHandler = { button in
            button.configuration?.background.backgroundColor = button.isHighlighted
                ? palette.card.blend(palette.pressed) : palette.card
        }
        button.isEnabled = enabled
        return button
    }

    private func tile(_ symbol: String, _ label: String, _ enabled: Bool, action: @escaping () -> Void) -> UIButton {
        let tile = button(enabled: enabled, action: action)
        tile.configuration?.image = UIImage(systemName: symbol,
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .regular))
        tile.configuration?.imagePlacement = .top
        tile.configuration?.imagePadding = 6
        tile.configuration?.title = label
        tile.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 4, bottom: 10, trailing: 4)
        tile.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = .systemFont(ofSize: 15)
            return attributes
        }
        tile.accessibilityLabel = label
        return tile
    }

    /// A setting that applies in place; the sheet stays open.
    private func toggle(_ label: String, isOn: Bool, changed: @escaping (Bool) -> Void) -> UIView {
        let title = UILabel()
        title.text = label
        title.font = .systemFont(ofSize: 16)
        title.textColor = palette.text
        title.adjustsFontSizeToFitWidth = true
        title.minimumScaleFactor = 0.8
        let control = UISwitch()
        control.isOn = isOn
        // Android's switch accent, rgb(64, 80, 172) light and rgb(90, 104, 200) dark.
        control.onTintColor = overrideUserInterfaceStyle == .dark
            ? UIColor(red: 90 / 255, green: 104 / 255, blue: 200 / 255, alpha: 1)
            : UIColor(red: 64 / 255, green: 80 / 255, blue: 172 / 255, alpha: 1)
        control.accessibilityLabel = label
        control.addAction(UIAction { [weak control] _ in
            if let control { changed(control.isOn) }
        }, for: .valueChanged)
        let row = UIStackView(arrangedSubviews: [title, control])
        row.alignment = .center
        row.spacing = 12
        row.isLayoutMarginsRelativeArrangement = true
        row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
        row.backgroundColor = palette.card
        row.layer.cornerRadius = 12
        row.heightAnchor.constraint(equalToConstant: 48).isActive = true
        return row
    }

    private func entry(id: String, label: String, enabled: Bool, iconDataUrl: String?, settingsId: String?) -> UIView {
        let row = button(enabled: enabled) { [weak self] in self?.choose(id) }
        row.configuration?.title = label
        row.configuration?.image = icon(iconDataUrl, manage: id == "once:manage")
        row.configuration?.imagePadding = 12
        row.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)
        row.configuration?.titleLineBreakMode = .byTruncatingTail
        row.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = .systemFont(ofSize: 16)
            return attributes
        }
        row.contentHorizontalAlignment = .leading
        // A long add-on name must not wrap: it would push the row taller
        // than its gear and spill into the entry below.
        row.titleLabel?.numberOfLines = 1
        row.heightAnchor.constraint(equalToConstant: 48).isActive = true
        guard let settingsId, !settingsId.isEmpty else { return row }
        let settings = button(enabled: true) { [weak self] in self?.choose(settingsId) }
        settings.configuration?.image = UIImage(systemName: "gearshape")
        settings.accessibilityLabel = "\(label) settings"
        settings.widthAnchor.constraint(equalToConstant: 48).isActive = true
        let line = UIStackView(arrangedSubviews: [row, settings])
        line.spacing = 8
        return line
    }

    private func icon(_ dataUrl: String?, manage: Bool) -> UIImage? {
        let prefix = "data:image/png;base64,"
        if let dataUrl, dataUrl.hasPrefix(prefix), dataUrl.count < 65536,
           let data = Data(base64Encoded: String(dataUrl.dropFirst(prefix.count))),
           let image = UIImage(data: data) {
            // Extension bitmaps keep their own colours at the glyphs' size.
            return UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in
                image.draw(in: CGRect(x: 0, y: 0, width: 20, height: 20))
            }.withRenderingMode(.alwaysOriginal)
        }
        return UIImage(systemName: manage ? "gearshape" : "puzzlepiece.extension")?
            .withTintColor(palette.icon, renderingMode: .alwaysOriginal)
    }
}

private extension UIColor {
    /// `overlay` composited over this colour.
    func blend(_ overlay: UIColor) -> UIColor {
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        overlay.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 + (r2 - r1) * a2, green: g1 + (g2 - g1) * a2, blue: b1 + (b2 - b1) * a2, alpha: a1)
    }
}
