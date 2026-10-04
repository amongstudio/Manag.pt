# Public access

Configuration → **Public access** can publish this dashboard on the internet through a reverse tunnel. The API binds the tunnel at `127.0.0.1` only. When you press **Start** or **Install** for Ngrok, Cloudflare Tunnel, or zrok and that binary is missing, the API downloads the pinned official client into `data/tools/` (not `/usr/bin`). It checks the sha256 committed next to the version pin and deletes the file if the hash does not match. Nothing is downloaded on API boot. LocalTunnel stays the `localtunnel` package. Pinggy uses the system `ssh` client and is not downloaded. The manual commands below are a fallback if you would rather install the client yourself.

The operator token is still required on the dashboard and on `/api/v1/admin/*`. A tunnel is not a backdoor. It does not change scan authorization, the allowlist, or lab mode.

## What is exposed

- **Dashboard tunnel** (default): `127.0.0.1:3000`. The dashboard proxies `/api` to the API, so this one tunnel is enough when that proxy works for the Host header the provider sends.
- **API tunnel** (optional): `127.0.0.1:4000`, only when **Also expose API port** is on. Clients that call the API host directly can use that URL. The dashboard URL keeps working either way.

One dashboard tunnel runs at a time. Start again with another provider stops the process this API launched and starts the new one. Stop signals that process id only. Other ngrok, cloudflared, or ssh processes on the machine are left alone.

The API restarts a tunnel it owns if the process exits, waiting 1s, 2s, 4s, 8s, then 16s. After five retries it stays on `error` with `retry_cap` until you press Stop. A tunnel does not start on API boot unless Start saved `enabled`. Shutting the API down stops the child process and leaves `enabled` as it was, so the next boot resumes only when that flag is set.

Tokens are write-only. The API never returns them. A blank password field keeps the saved value. Audit rows (`tunnel_save`, `tunnel_start`, `tunnel_stop`) record the provider name, not the secret.

## Ngrok

Press **Install** or **Start**. The API downloads ngrok **3.39.11** (linux amd64 on this host; linux arm64 and windows amd64 are pinned too) from `https://bin.ngrok.com` into `data/tools/ngrok` after the sha256 matches. A manual install onto `PATH` still works:

```bash
curl -fsSL https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar -xz -C "$HOME/.local/bin"
```

Paste the authtoken in the password field. The API passes it as `NGROK_AUTHTOKEN` and writes a mode `0600` config file. The token is not placed on the command line and is not written to the API log. The process is `ngrok http http://127.0.0.1:3000 --log=stdout`. The public URL is read from that log or from the ngrok agent API on `127.0.0.1:44040` (and `44041` for the API port).

## Cloudflare Tunnel

Press **Install** or **Start**. The API downloads cloudflared **2026.9.3** from the GitHub release into `data/tools/cloudflared` after the sha256 matches. Manual fallback:

```bash
curl -fsSL -o "$HOME/.local/bin/cloudflared" https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-linux-amd64 && chmod +x "$HOME/.local/bin/cloudflared"
```

Leave the token blank for a quick tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

The page shows the `*.trycloudflare.com` URL from the process output. `--no-autoupdate` is set so cloudflared does not download a new binary.

A named tunnel token uses `cloudflared tunnel run --token`. The hostname is the one configured in Cloudflare. The token is masked in the API and in audit logs. It is an argument to that process, so it can appear in the local process list the same way it would if you ran the command yourself. With a named token, the API-port toggle does not start a second cloudflared.

## LocalTunnel

The API uses the `localtunnel` package inside the API process. Install it from the repo if it is missing:

```bash
pnpm --filter api add localtunnel
```

Subdomain is optional. The default host is `https://localtunnel.me`. You can point Host at another HTTPS LocalTunnel server. The upstream host is `127.0.0.1`.

## zrok

Press **Install** or **Start**. The API downloads zrok **2.0.7** from the openziti GitHub release, checks the sha256 of the archive, and saves the `zrok2` binary as `data/tools/zrok`. Enable the account yourself. This API does not run `zrok enable`, so the token is stored for your records and is not passed to a process.

Manual fallback:

```bash
curl -fsSL -o /tmp/zrok.tgz https://github.com/openziti/zrok/releases/download/v2.0.7/zrok_2.0.7_linux_amd64.tar.gz
tar -xzf /tmp/zrok.tgz -C "$HOME/.local/bin" zrok2
mv "$HOME/.local/bin/zrok2" "$HOME/.local/bin/zrok"
chmod +x "$HOME/.local/bin/zrok"
zrok enable
```

Start then runs the pinned client headless. zrok 2 has no `--unique-name` flag, so leave subdomain blank:

```bash
zrok share public --headless http://127.0.0.1:3000
```

If `ssh` is missing for Pinggy, Start still returns `provider_unavailable` and does not download a client.

## Pinggy

Pinggy uses the OpenSSH client already on the host. The API does not download ssh.

```bash
sudo apt-get install -y openssh-client
```

Without a token the API runs:

```bash
ssh -p 443 -R0:127.0.0.1:3000 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes a.pinggy.io
```

With a token, the destination is `TOKEN@a.pinggy.io`. The token is masked in the API and in audit logs. It is the SSH username, so it can appear in the local process list. The public `*.pinggy.link` URL is parsed from the session output.

## After it is up

Copy the dashboard URL from the status card and open it. Sign in with the same operator token or password you use locally. Closing the tunnel with Stop makes that URL go away. Removing the provider binary later does not delete the saved token; clear it by saving a new value or by replacing the `tunnel` row.
