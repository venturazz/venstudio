# Where the YouTube keys go

## Short answer

- **Don't upload the file into Studio or Assets, and don't commit it to GitHub.** Assets are readable by every signed-in user and can be downloaded.
- **A service-account `key.json` won't work.** YouTube doesn't let service accounts upload to channels. Each channel has to sign in and approve access.
- **The file you need is the OAuth client JSON** (Google Cloud → Credentials → OAuth client ID, type *Web application*). Copy its two values into Coolify's environment variables:

| Coolify variable | Value |
|---|---|
| `YOUTUBE_CLIENT_ID` | `client_id` from the JSON |
| `YOUTUBE_CLIENT_SECRET` | `client_secret` from the JSON |
| `YOUTUBE_REDIRECT_URI` | `https://<your domain>/api/youtube/callback` (added to the OAuth client's redirect URIs) |

Then delete the downloaded JSON file from your computer, or keep it in a password manager.

## Where Studio fits

Studio holds the **connection**, not the key file:
- Each channel gets a **Connect YouTube** button. Sign in with the Google account that owns the channel, and choose that channel when Google asks.
- Google returns a refresh token for that channel. The portal stores it **encrypted** with `ENCRYPTION_KEY`, and only the portal can use it. Muse workers never see it.
- Your five Google accounts each connect their two channels. Ten channels, one OAuth client.

This button is part of the next phase (the YouTube connection). The variables above are needed before it works.

## Google Cloud setup (one time)

1. Create a project and enable **YouTube Data API v3** and **YouTube Analytics API**.
2. OAuth consent screen: type *External*, and set the publishing status to **In production**. In *Testing*, refresh tokens expire after 7 days, which would disconnect every channel each week.
3. Credentials → Create OAuth client ID → *Web application*. Add the redirect URI above.
4. Download the JSON, then copy the two values into Coolify as shown.

Quota: uploads have their own bucket of 100 per day per project, which is enough for 10 channels at 2 videos a day.
