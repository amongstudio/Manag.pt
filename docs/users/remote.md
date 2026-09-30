# Remote shell, desktop, and files

## Desktop

WebRTC on the device **Desktop** tab. Media is DTLS/SRTP. The dashboard can pick a display, send clipboard text, and use the existing file channel for transfers. Those controls were already in the product; this line of work did not add a new capture stack.

Session flags stored on the `webrtc:<deviceId>` row:

- Watermark text, shown in the assistant card when set
- Consent flag
- Privacy-screen flag. This is recorded only. It does not blank the console
- Owner
- Timeout in minutes (5–240), which sets the row expiry
- Invite token. **New invite token** shows the token once. **Transfer** checks that token and updates the owner. The token does not bypass operator login

Start and end of a remote session write `AuditLog` rows (`remote_session_start` / `remote_session_end`).

## Shell

One shell per device, PowerShell or cmd on Windows, via Socket.io `shell_open` / `shell_data` / `shell_resize` / `shell_close`. Other platforms show that the shell path is Windows-oriented in this version. Confirm before open.

## Files

The file explorer lists sandbox paths (home, temp, and extra `sandbox_roots`). Upload, download, and drag-and-drop use the existing file channel. Paths still go through the sandbox. Mesh copy, when mesh is enabled, uses the mTLS listener on port 17891.
