# Twitch channel points setup

The prediction market converts broadcaster-created Twitch Channel Point rewards into free KOTH
Crowns. Redemptions only succeed for viewers who have signed into KOTH with the same Twitch account,
and rewards are enabled only while an event is live.

## Twitch application

1. Use a Twitch application owned by the KOTH operator. The broadcaster must be a Twitch Affiliate
   or Partner to use custom rewards.
2. Add this exact OAuth redirect URL in the Twitch developer console for each environment:

   ```text
   {BETTER_AUTH_URL}/api/predictions/admin/twitch-callback
   ```

3. Set the application's client ID and client secret as `TWITCH_CLIENT_ID` and
   `TWITCH_CLIENT_SECRET`.

The broadcaster connection requests only `channel:manage:redemptions`. Viewer sign-in uses the same
Twitch application through Better Auth.

## Environment

Set these values in the deployed application:

```dotenv
BETTER_AUTH_URL=https://your-domain.com
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
TWITCH_BROADCASTER_LOGIN=hydramist
TWITCH_EVENTSUB_SECRET=...
TWITCH_EVENTSUB_CALLBACK_URL=https://your-domain.com/api/twitch/eventsub
CHANNEL_POINTS_TO_CROWNS_RATE=1000
CHANNEL_POINTS_MAX_PER_USER_PER_EVENT=10000
```

`TWITCH_EVENTSUB_SECRET` must be 10-100 printable ASCII characters; a 64-character random hex value
is appropriate. The callback must be publicly reachable over HTTPS on port 443. With the example
values, rewards cost 1,000 points per Crown and each viewer can convert at most 10,000 points per
event, so the generated rewards are 1 Crown and 10 Crowns.

`PREDICTION_DATABASE_URI` is optional when `DATABASE_URI` points at the intended prediction database.

## Bring-up

1. Deploy the application and run `bun run predictions:migrate` against the deployed database.
2. Sign into `/predictions` with the operator's Twitch account and grant it prediction admin access
   with `bun run predictions:grant-admin -- operator@example.com` if needed.
3. Open `/predictions/control`, expand **Twitch channel points**, and select **Connect broadcaster**.
   Authorize the account named by `TWITCH_BROADCASTER_LOGIN`.
4. Select **Sync rewards**, then **Sync webhook**. Both operations are safe to rerun. Webhook sync
   replaces the existing subscription so a changed callback secret takes effect.
5. Activate an event. The rewards become visible on Twitch. Completing the event disables them.

Viewers must sign into `/predictions` with Twitch before redeeming. Unknown KOTH users, out-of-sync
reward costs, redemptions above the event cap, and redemptions made without a live event are refunded
through Twitch.
