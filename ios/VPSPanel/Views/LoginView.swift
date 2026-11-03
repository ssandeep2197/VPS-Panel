import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var method: Session.Method = .tms
    @State private var modeKnown = false
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
                .onChange(of: server) { _, _ in modeKnown = false }

                Section {
                    Picker("Sign in with", selection: $method) {
                        Text("TMS account").tag(Session.Method.tms)
                        Text("Panel password").tag(Session.Method.panel)
                    }
                    .pickerStyle(.segmented)
                    TextField(method == .tms ? "Email" : "Username", text: $username)
                        .keyboardType(method == .tms ? .emailAddress : .default)
                        .textContentType(method == .tms ? .emailAddress : .username)
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
                if username.isEmpty, let u = session.username { username = u }
                method = session.method
            }
            .onChange(of: method) { _, new in
                // The two sign-ins use different names: never carry "admin" into the email field or an email into the username
                if new == .tms, !username.contains("@") { username = "" }
                if new == .panel, username.contains("@") { username = "" }
            }
            .task(id: server) {
                // Ask the server which sign-in it offers; default to the TMS account when it does
                guard !modeKnown else { return }
                try? await Task.sleep(for: .milliseconds(400))
                if let mode = await session.authMode(server: server) {
                    method = mode.tms ? .tms : .panel
                    if method == .tms, !username.contains("@") { username = "" }
                    modeKnown = true
                }
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
                try await session.login(server: server, username: username, password: password, method: method)
            } catch let err as URLError {
                error = "Cannot reach the server: \(err.localizedDescription)"
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
