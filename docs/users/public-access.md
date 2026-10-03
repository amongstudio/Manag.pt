# Public access

Configuration → **Public access** can publish this dashboard on the internet through a reverse tunnel. The API binds the tunnel at `127.0.0.1` only. It does not download ngrok, cloudflared, zrok, or ssh for you. If the binary (or, for LocalTunnel, the `localtunnel` package) is missing, Start returns `provider_unavailable` and the page shows one install command.

The operator token is still required on the dashboard and on `/api/v1/admin/*`. A tunnel is not a backdoor. It does not change scan authorization, the allowlist, or lab mode.

## What is exposed

- **Dashboard tunnel** (default): `127.0.0.1:3000`. The dashboard proxies `/api` to the API, so this one tunnel is enough when that proxy works for the Host header the provider sends.
- **API tunnel** (optional): `127.0.0.1:4000`, only when **Also expose API port** is on. Clients that call the API host directly can use that URL. The dashboard URL keeps working either way.

One dashboard tunnel runs at a time. Start again with another provider stops the process this API launched and starts the new one. Stop signals that process id only. Other ngrok, cloudflared, or ssh processes on the machine are left alone.

The API restarts a tunnel it owns if the process exits, waiting 1s, 2s, 4s, 8s, then 16s. After five retries it stays on `error` with `retry_cap` until you press Stop. A tunnel does not start on API boot unless Start saved `enabled`. Shutting the API down stops the child process and leaves `enabled` as it was, so the next boot resumes only when that flag is set.

Tokens are write-only. The API never returns them. A blank password field keeps the saved value. Audit rows (`tunnel_save`, `tunnel_start`, `tunnel_stop`) record the provider name, not the secret.

## Ngrok

Install ngrok and put it on the API host `PATH`.

```bash
curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar -xz -C "$HOME/.local/bin"
```

Paste the authtoken in the password field. The API passes it as `NGROK_AUTHTOKEN` and writes a mode `0600` config file. The token is not placed on the command line and is not written to the API log. The process is `ngrok http http://127.0.0.1:3000 --log=stdout`. The public URL is read from that log or from the ngrok agent API on `127.0.0.1:44040` (and `44041` for the API port).

## Cloudflare Tunnel

Install `cloudflared`.

```bash
curl -fsSL -o "$HOME/.local/bin/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x "$HOME/.local/bin/cloudflared"
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

Install zrok, then enable it in a shell with your account token. Do that yourself. This API does not run `zrok enable`, so the token is stored for your records and is not passed to a process.

```bash
curl -sSLf https://get.openziti.io/install.bash | sudo bash -s zrok
zrok enable
```

Start then runs:

```bash
zrok share public http://127.0.0.1:3000
```

An optional subdomain is sent as `--unique-name`. If `zrok` is not on `PATH`, Start returns the install command and does not spawn anything.

## Pinggy

Pinggy uses the OpenSSH client.

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
