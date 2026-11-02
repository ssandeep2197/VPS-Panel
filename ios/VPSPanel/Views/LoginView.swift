import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case server, username, password }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        PanelLogo(size: 88)
                        Text("VPS Panel").font(.title2.weight(.bold))
                        Text("Sign in to manage your server").font(.footnote).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }
                Section {
                    TextField("https://panel.example.com", text: $server)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .server)
                        .submitLabel(.next)
                        .onSubmit { focus = .username }
                } header: {
                    Text("Server")
                } footer: {
                    Text("The address of your VPS Panel. Use http://<ip>:4600 only on a private network.")
                }

                Section("Sign in") {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button(action: submit) {
                        HStack {
                            Spacer()
                            if busy { ProgressView().padding(.trailing, 6) }
                            Text("Sign in").bold()
                            Spacer()
                        }
                    }
                    .disabled(busy || username.isEmpty || password.isEmpty || server.isEmpty)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                if server.isEmpty { server = session.serverURL }
                if username.isEmpty { username = session.username ?? "admin" }
            }
        }
    }

    private func submit() {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await session.login(server: server, username: username, password: password)
            } catch let err as URLError {
                error = "Cannot reach the server: \(err.localizedDescription)"
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
