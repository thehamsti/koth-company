# Production deployment on `hamsti1`

This stack is independent of Coolify and the host Traefik instance. It publishes no host ports. A dedicated named Cloudflare Tunnel reaches Caddy on the Compose `edge` network; only Caddy also joins the private application network. The connector reads its tunnel token from a file and supplies its single origin URL on the command line, so it does not depend on dashboard-managed ingress rules.

## Routine deployment

The repository-level GitHub Actions runner on `hamsti1` waits for outbound job assignments; it does
not expose a webhook or another public port. A production deployment validates and publishes an
immutable SHA on GitHub-hosted runners, then assigns only the final install job to the dedicated
`koth-production` runner.

From a clean checkout whose commit has been pushed to GitHub, run:

```sh
bun run deploy:production -- --markets-disabled
```

Use `--markets-enabled` only when production `api.env` intentionally contains
`PREDICTION_MARKETS_ENABLED=true`. The acknowledgement is mandatory so a deployment cannot silently
change the product state. To inspect the target without dispatching anything:

```sh
bun run deploy:production -- --dry-run --markets-disabled
```

The command resolves `HEAD` to a full SHA, rejects a dirty or unpushed checkout, dispatches the
trusted workflow definition from `main`, prints the resumable Actions URL, waits for every validation
and image job, then waits for `hamsti1` to finish migrations, health checks, and external SSE
verification. Pass `--ref <commit-ish>` to release another pushed commit.

The final runner job downloads only the artifact produced by that workflow run. It checks the archive
paths and release marker, uses the job-scoped GitHub token through a temporary Docker configuration,
and deletes that credential after the job. It never replaces `deploy.env`, service environment files,
or the Cloudflare tunnel token. Bundle files are installed while holding the production deployment
lock and are restored if the target runtime fails and rolls back.

## One-time runner setup

The repository is private, and the production runner is registered only to this repository. Bootstrap
the pinned, checksum-verified Linux runner from an administrator checkout:

```sh
bun run setup:production-runner
```

The command registers `hamsti1-koth-production` with the `koth-production` label and installs a
user-owned cron supervisor. The supervisor invokes GitHub's `bin/runsvc.sh` service entrypoint under a
non-blocking lock, starts within one minute after boot, and starts another listener if the process
exits. It preserves existing crontab entries and needs no public listener or sudo access. The
registration token is short-lived and is streamed directly to the server; it is not saved in the
repository or shell history.

The runner account can access the production Docker daemon and configuration. Treat permission to
modify repository workflows as production access, and never allow workflows from untrusted pull
requests to target the `koth-production` label.

After setup, confirm the runner is idle under **Repository settings → Actions → Runners**. Configure
required reviewers on the GitHub `production` environment if deployments should require a separate
approval after images finish publishing.

## Publish an immutable release

The worker-backed command above is the normal path. For a publish-only or recovery operation, run
**Release self-hosted images** with `deploy` disabled and a branch, tag, or full SHA. The workflow
validates the exact checkout, publishes private `linux/amd64` images tagged with its resolved
40-character SHA, and uploads `koth-deploy-<SHA>`, an artifact containing the deployment files from
that same checkout.

Download and inspect that artifact rather than copying deployment files from a later `main` checkout:

```sh
SHA=0123456789abcdef0123456789abcdef01234567
gh run download RUN_ID --name "koth-deploy-$SHA"
tar -xzf "koth-deploy-$SHA.tar.gz"
test "$(cat "koth-company-$SHA/RELEASE")" = "$SHA"
```

The root-owned Docker client used by the operations scripts needs read access to the private packages:

```sh
sudo docker login ghcr.io --username thehamsti
```

Use a read-only classic PAT with `read:packages` when prompted. Never deploy `latest` or a branch tag.

## Install the stack

From the extracted `koth-company-$SHA` directory on `hamsti1`:

```sh
sudo install -d -m 0750 /srv/koth-company/ops /srv/koth-company/releases /etc/koth-company
sudo install -m 0640 RELEASE /srv/koth-company/deployment-release
sudo install -m 0640 deploy/compose.yaml /srv/koth-company/compose.yaml
sudo install -m 0644 deploy/Caddyfile /srv/koth-company/Caddyfile
sudo install -m 0750 deploy/ops/common.sh deploy/ops/deploy deploy/ops/rollback deploy/ops/status /srv/koth-company/ops/
sudo install -m 0640 deploy/env/deploy.env.example /srv/koth-company/deploy.env
sudo install -m 0640 deploy/env/web.env.example /etc/koth-company/web.env
sudo install -m 0640 deploy/env/api.env.example /etc/koth-company/api.env
sudo install -m 0640 deploy/env/migrate.env.example /etc/koth-company/migrate.env
```

If the SSH operator already has Docker access but sudo requires an interactive password, use the
same layout under that operator's home directory. Pass both supported overrides on every operation:

```sh
export KOTH_ROOT="$HOME/koth-company"
export KOTH_CONFIG_DIR="$HOME/.config/koth-company"
install -d -m 0700 "$KOTH_ROOT/ops" "$KOTH_ROOT/releases" "$KOTH_CONFIG_DIR"
# Install the same bundle and environment files under these two directories.
KOTH_ROOT="$KOTH_ROOT" KOTH_CONFIG_DIR="$KOTH_CONFIG_DIR" \
  "$KOTH_ROOT/ops/deploy" "$SHA" --markets-disabled
```

Keep environment files and the tunnel token mode `0600` in a user-owned install. Do not use this
variant for an account shared with untrusted shell users. Install `Caddyfile` mode `0644`; it contains
no secrets, and rootless Docker requires that read bit for the bind mount.

Repeat the `deployment-release`, Compose, Caddy, and operations-script installs from each new SHA bundle before deploying that SHA. Preserve the configured environment and token files. The deploy runner rejects a release whose installed bundle marker names a different commit.

Replace every placeholder. Keep the existing production Payload, Better Auth, Twitch, EventSub, ingestion, and CV secrets; rotating them during this cutover would invalidate sessions or integrations. `migrate.env` intentionally contains only `DATABASE_URI`, `PAYLOAD_SECRET`, and `PREDICTION_DATABASE_URI`; those three values must exactly match the corresponding service files.

The deploy scripts reject placeholders, duplicate or missing keys, invalid URLs, short secrets, mismatched migration databases, world-readable config, and an ambiguous prediction-market setting. `deploy.env` must also name the public hostname used to verify this stack:

```dotenv
KOTH_REGISTRY=ghcr.io/thehamsti/koth-company
KOTH_PUBLIC_ORIGIN=https://koth.company
```

## Provision the Cloudflare tunnel

`koth.company` must use a Cloudflare DNS zone before a public Tunnel hostname can terminate TLS. The
Vercel project has been deleted, but the domain remains registered through Vercel. Add the domain to
the same Cloudflare account as the tunnel, then keep or create these apex CAA records in the new zone:

```text
CAA  @  0 issue "pki.goog"
CAA  @  0 issue "sectigo.com"
CAA  @  0 issue "letsencrypt.org"
```

Cloudflare may import the old Vercel apex and wildcard records while scanning the zone. Delete those
records; they point at a project that no longer exists. Before deployment, create proxied Tunnel
records for both the apex and `origin.koth.company`. A Cloudflare 530 response is expected until the
first connector starts.

On a trusted admin machine with `cloudflared` installed, authenticate to that Cloudflare account,
create the dedicated tunnel, and write its token to a private file:

```sh
cloudflared tunnel login
cloudflared tunnel create koth-company
umask 077
cloudflared tunnel token koth-company > cloudflare-tunnel.token
```

The create command also writes a tunnel credentials JSON file. The deployed connector does not need that file or the account-level `cert.pem`; it authenticates with the generated token and sends all traffic to the explicit Compose origin `http://gateway:8080`.

In the new Cloudflare DNS zone, create proxied `CNAME` records for both `@` and `origin` whose target
is `<TUNNEL_ID>.cfargotunnel.com`. The production tunnel ID is
`8300af3e-7cff-403a-9327-010a0635de92`; confirm it without exposing the token:

```sh
cloudflared tunnel list --output json | jq -r '.[] | select(.name == "koth-company") | .id'
```

Do not run `cloudflared tunnel route dns` with a per-machine default configuration for another zone;
an inherited tunnel or hostname can create a record in the wrong zone.

Before deployment, add Cloudflare cache bypass rules for `/api/*`, `/predictions*`, and `/admin*`.

Once the zone contains the CAA and Tunnel records, open the Vercel dashboard, select **Domains →
koth.company → Nameservers → Edit**, and replace the Vercel nameservers with the two nameservers
assigned by Cloudflare. Both hostnames become public as delegation propagates and remain unavailable
until the first healthy connector starts.

Copy only the token to `hamsti1`, install it as a root-readable secret, and remove the transfer copies:

```sh
scp cloudflare-tunnel.token hamsti1:/tmp/koth-company-cloudflare-tunnel.token
ssh hamsti1 'sudo install -o root -g root -m 0600 /tmp/koth-company-cloudflare-tunnel.token /etc/koth-company/cloudflare-tunnel.token'
ssh hamsti1 'rm -f /tmp/koth-company-cloudflare-tunnel.token'
rm -f cloudflare-tunnel.token
```

Do not add the token to an environment file. At start, the operations script streams this private host file into a dedicated Docker volume with an atomic mode-0600 replacement so userns-remapped containers can read it without weakening the host file mode. Both bridge networks allow required outbound database and Twitch traffic, but no service is reachable from a host or internet port.

## First deployment and production-host verification

Start with `PREDICTION_MARKETS_ENABLED=false` unless live trading is intentionally part of the cutover. The required second argument makes that decision explicit:

```sh
sudo /srv/koth-company/ops/deploy "$SHA" --markets-disabled
sudo /srv/koth-company/ops/status
```

Use `--markets-enabled` only when `api.env` explicitly contains `PREDICTION_MARKETS_ENABLED=true`.

Before recording the release as current, deployment performs all of these checks:

- Container health for web, API, Caddy, and the Cloudflare connector.
- Payload and prediction migrations in a read-only, resource-limited container that receives no Twitch, auth, ingestion, or CV credentials.
- Internal web readiness, API/database readiness, and Caddy routing.
- A locally signed EventSub callback challenge through Caddy.
- Anonymous `/healthz`, API liveness/readiness, and an initial public SSE event through the configured apex and Cloudflare edge.

The automated deployment checks are anonymous. After they pass, test authenticated Twitch OAuth and a real EventSub synchronization on `https://koth.company`. Never use `origin.koth.company` for authentication or callbacks because Better Auth and Twitch are pinned to the apex. Migrations are not reversible, so every migration must remain compatible with the previous release.

## Grant Hydramist control access

Hydramist must first sign in once at `https://koth.company/predictions` with Twitch so Better Auth creates and links the account. Then run the bundled admin command against the live API container:

```sh
sudo env \
  KOTH_RELEASE="$(sudo cat /srv/koth-company/releases/current)" \
  KOTH_CONFIG_DIR=/etc/koth-company \
  docker compose \
    --project-directory /srv/koth-company \
    --env-file /srv/koth-company/deploy.env \
    --file /srv/koth-company/compose.yaml \
    exec -T api bun /app/grant-admin.js --twitch-login hydramist
```

The command is idempotent and fails with an actionable message if Hydramist has not signed in with Twitch yet.

## Post-deploy acceptance

After the automated apex checks pass:

1. Run the status command again and verify Twitch sign-in, authenticated `/predictions/control`, a real EventSub sync/challenge, trading, and CV SSE reconnection.
2. After Hydramist signs in once with Twitch, grant the account control access using the command above.
3. If markets were staged off, change `PREDICTION_MARKETS_ENABLED=true` and redeploy the same SHA with `--markets-enabled`.
4. Observe both public routes and retire the diagnostic `origin.koth.company` alias only after the observation window.

The existing Twitch application remains in use. Production Better Auth, OAuth redirect, and EventSub callback URLs stay on `https://koth.company`, so the hosting split does not require another app.

## Rollback and operations

Rollback swaps the current and previous immutable releases without rerunning migrations:

```sh
sudo /srv/koth-company/ops/rollback
```

There is no Vercel application rollback target. Use the retained image rollback for application
failures. Application rollback cannot repair Cloudflare failures; leave both records on the dedicated
tunnel while repairing its token, connector, or routing, and do not point them back to deleted Vercel.

Successful operations retain current and previous web, API, and migration images and remove older SHA-tagged KOTH images only. Rollback uses retained images and pulls a component only if that specific image is unexpectedly absent.

Inspect bounded logs with:

```sh
cd /srv/koth-company
sudo KOTH_RELEASE="$(sudo cat releases/current)" docker compose --env-file deploy.env logs --tail 200 api web gateway cloudflared
```
