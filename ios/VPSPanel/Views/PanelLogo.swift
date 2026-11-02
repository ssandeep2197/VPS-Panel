import SwiftUI

/// The panel mark: three server bays on a blue gradient. Same design as the app icon.
struct PanelLogo: View {
    var size: CGFloat = 96

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(LinearGradient(colors: [Color(red: 0.07, green: 0.13, blue: 0.30), Color(red: 0.16, green: 0.42, blue: 0.92)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
            VStack(spacing: size * 0.035) {
                bay(dot: .green)
                bay(dot: .green)
                bay(dot: .orange)
            }
            .frame(width: size * 0.55)
        }
        .frame(width: size, height: size)
        .shadow(color: .black.opacity(0.18), radius: size * 0.08, y: size * 0.04)
        .accessibilityLabel("VPS Panel")
    }

    private func bay(dot: Color) -> some View {
        HStack(spacing: size * 0.025) {
            ForEach(0..<4, id: \.self) { _ in
                Capsule().fill(Color(red: 0.16, green: 0.42, blue: 0.92).opacity(0.3))
                    .frame(width: size * 0.018, height: size * 0.055)
            }
            Spacer()
            Circle().fill(dot).frame(width: size * 0.043, height: size * 0.043)
        }
        .padding(.horizontal, size * 0.055)
        .frame(height: size * 0.125)
        .background(Color.white.opacity(0.96), in: RoundedRectangle(cornerRadius: size * 0.03, style: .continuous))
    }
}

#Preview {
    VStack(spacing: 24) {
        PanelLogo(size: 160)
        PanelLogo(size: 60)
    }
    .padding()
}
