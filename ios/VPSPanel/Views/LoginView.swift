import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @Environment(Session.self) private var session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var method: Session.Method = .tms
    @State private var mode: AuthMode?
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

                Section {
                    if mode?.tms ?? true, mode?.legacy ?? true {
                        Picker("Sign in with", selection: $method) {
                            Text("TMS account").tag(Session.Method.tms)
                            Text("Panel password").tag(Session.Method.panel)
                        }
                        .pickerStyle(.segmented)
                    }
                    if method == .panel {
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
                } footer: {
                    if method == .tms {
                        Text("You will be taken to the TMS sign-in page and back. Access to the panel is granted per account in the TMS admin portal.")
                    }
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
                            Text(method == .tms ? "Sign in with TMS" : "Sign in").bold()
                            Spacer()
                        }
                    }
                    .disabled(busy || server.isEmpty || (method == .panel && (username.isEmpty || password.isEmpty)))
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                if server.isEmpty { server = session.serverURL }
                if username.isEmpty, let u = session.username, !u.contains("@") { username = u }
                method = session.method
            }
            .task(id: server) {
                // Ask the server which sign-ins it offers; default to TMS when it is on
                mode = nil
                try? await Task.sleep(for: .milliseconds(400))
                if let found = await session.authMode(server: server) {
                    mode = found
                    method = found.tms ? .tms : .panel
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
                switch method {
                case .panel:
                    try await session.login(server: server, username: username, password: password)
                case .tms:
                    // The TMS sign-in page opens in a browser sheet; the server ends it with vpspanel://signed-in?token=…
                    let start = try session.tmsLoginURL(server: server)
                    let callback = try await webAuthenticationSession.authenticate(using: start, callbackURLScheme: Session.callbackScheme)
                    try await session.completeTmsLogin(server: server, callback: callback)
                }
            } catch let err as URLError {
                error = "Cannot reach the server: \(err.localizedDescription)"
            } catch let err as ASWebAuthenticationSessionError where err.code == .canceledLogin {
                // The person closed the sheet
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
