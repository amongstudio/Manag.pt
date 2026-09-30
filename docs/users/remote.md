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

Start and end of a remote session write `AuditLog` rows (`remote_session_start` / `remote_session_end`) with the operator's identity. The end row includes the reason and duration. Turning remote input on or off during a session writes `remote_session_input`.

Session rules enforced by the API relay and the agent:

- The browser tab that sends the offer owns the device's session, bound to that socket and the signed-in operator. ICE, control, and hangup messages from any other socket are refused (`session_not_owned`). A new offer from another tab or operator takes over, and the previous owner is told `session_replaced`. Agent answers and ICE go only to the owner.
- A session has an absolute limit of 8 hours from start, enforced by both the API and the agent. Signaling does not extend it. At the limit, both ends hang up with `session_expired`.
- Closing the tab, disconnecting, or detaching from the device ends the owned session and hangs up the agent.
- Signaling is limited to 150 messages per 10 seconds per socket (`signal_rate_limited`). On the agent, remote input is limited to 240 events per second (burst 480), with typed text capped at 1024 characters per event (`input_throttled`). Clipboard requests are limited to 4 per second (`clipboard_rate_limited`).

### Clipboard history

History used to repeat while connected because every poll of an unchanged clipboard added a new row. Now both the agent's history (up to 50 entries, in memory only, never logged) and the dashboard history skip content that has not changed, and a clip copied again moves to the top instead of being duplicated.

**Fetch from device** works without a desktop session. It queues the audited `get_clipboard` command, which reads the clipboard once and returns the agent's recent history. Command lists, sockets, and alerts only receive a redacted summary (`{ redacted, history, hasCurrent }`). The full result is available only from the single-command endpoint, and it is replaced by that summary after 15 minutes. Mesh peers can never forward `get_clipboard`.

## Shell

One shell per device, PowerShell or cmd on Windows, via Socket.io `shell_open` / `shell_data` / `shell_resize` / `shell_close`. Other platforms show that the shell path is Windows-oriented in this version. Confirm before open.

## Files

The file explorer lists sandbox paths (home, temp, and extra `sandbox_roots`). Upload, download, and drag-and-drop use the existing file channel. Paths still go through the sandbox. Mesh copy, when mesh is enabled, uses the mTLS listener on port 17891.
