# Twitch channel points setup

The prediction market converts broadcaster-created Twitch Channel Point rewards into free KOTH
Crowns. Redemptions only succeed for viewers who have signed into KOTH with the same Twitch account
and checked in to the live event, and rewards are enabled only while an event is live. Checking in
to an event is what claims a viewer's starting Crowns: the balance is granted once, when the viewer
selects **Check in and claim Crowns** on `/predictions`, not when they first open the page.

## Twitch application

1. Reuse the existing Twitch application owned by the KOTH operator. Do not create a second app for
   the self-hosted API. The broadcaster must be a Twitch Affiliate or Partner to use custom rewards.
2. Add this exact OAuth redirect URL in the Twitch developer console for each environment:

   ```text
   {BETTER_AUTH_URL}/api/predictions/admin/twitch-callback
   ```

3. Set the application's client ID and client secret as `TWITCH_CLIENT_ID` and
   `TWITCH_CLIENT_SECRET`.

The broadcaster connection requests only `channel:manage:redemptions`. Viewer sign-in uses the same
Twitch application through Better Auth.

## Environment

Set these values in the API environment:

```dotenv
BETTER_AUTH_URL=https://your-domain.com
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
TWITCH_BROADCASTER_LOGIN=hydramist
TWITCH_EVENTSUB_SECRET=...
TWITCH_EVENTSUB_CALLBACK_URL=https://your-domain.com/api/twitch/eventsub
TWITCH_HTTP_TIMEOUT_MS=10000
CHANNEL_POINTS_TO_CROWNS_RATE=1000
CHANNEL_POINTS_MAX_PER_USER_PER_EVENT=10000
```

`TWITCH_EVENTSUB_SECRET` must be 10-100 printable ASCII characters; a 64-character random hex value
is appropriate. The callback must be publicly reachable over HTTPS on port 443. With the example
values, rewards cost 1,000 points per Crown and each viewer can convert at most 10,000 points per
event, so the generated rewards are 1 Crown and 10 Crowns.

`TWITCH_HTTP_TIMEOUT_MS` bounds OAuth and Helix calls. Keep it at 10 seconds unless the network path
requires a higher value; the API rejects values above 30 seconds.

`PREDICTION_DATABASE_URI` is required in the separated API deployment. Keep `BETTER_AUTH_URL`, the
OAuth redirect, and the EventSub callback on the public apex. `origin.koth.company` is only an
anonymous diagnostic alias.

## Bring-up

1. Deploy the application; the manual deployment runner applies Payload and prediction migrations.
2. Sign into `/predictions` once with the operator's Twitch account, then grant access by Twitch
   identity. For a local checkout, run
   `bun run predictions:grant-admin -- --twitch-login hydramist`. On `hamsti1`, run the exact bundled
   `/app/grant-admin.js --twitch-login hydramist` command documented in `deploy/README.md`.
3. Open `/predictions/control`, expand **Twitch channel points**, and select **Connect broadcaster**.
   Authorize the account named by `TWITCH_BROADCASTER_LOGIN`.
4. Select **Sync rewards**, then **Sync webhook**. Both operations are safe to rerun. Webhook sync
   replaces the existing subscription so a changed callback secret takes effect.
5. Activate an event. The rewards become visible on Twitch. Completing the event disables them.

Deployment verifies a correctly signed EventSub challenge locally, then verifies anonymous health
and public SSE through `KOTH_PUBLIC_ORIGIN` (`https://koth.company` in production). Perform Twitch
OAuth and real EventSub synchronization only against the apex because Twitch validates the exact
registered production URLs.

Viewers must sign into `/predictions` with Twitch and check in to the event before redeeming.
Unknown KOTH users, viewers who have not checked in, out-of-sync reward costs, redemptions above the
event cap, and redemptions made without a live event are refunded through Twitch.
