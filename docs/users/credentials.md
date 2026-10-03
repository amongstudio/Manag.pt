# Credentials vault

The vault stores secrets that an operator types into the dashboard. It does not read browser passwords, Windows Credential Manager, LSA secrets, SAM, or saved Wi-Fi keys.

Open a device, then **Admin → Credentials**.

- **New credential** saves a target, username, and secret. Choose **device** or **fleet**. A device credential is listed only for that device. Fleet credentials appear only when you ask for the fleet scope.
- The list and the credential detail show a masked row (`hasSecret`). They do not include the secret, password, or private key.
- **Reveal** asks you to confirm, then calls `POST /api/v1/admin/devices/:id/credentials/:credId/reveal`. That is the only response that contains the secret.
- **Unvault** deletes the row. A masked value such as `••••` is not stored as a new secret.
- Create, update, and delete write an `AuditLog` row with the credential name and device id. The secret is not in the audit detail.

Encryption is AES-256-GCM. The key is `CREDENTIALS_KEY`, or `UPDATE_SIGNING_SECRET` when that is unset. A different key cannot decrypt an existing blob. Changing the key makes old rows unreadable.
