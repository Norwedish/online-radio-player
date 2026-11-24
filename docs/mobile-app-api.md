# Remote-control app API (Android)

Everything a phone or tablet app needs to control the station: sign-in, tokens, the endpoints a
remote uses, live updates over WebSocket and how to react to errors. The API is the same one the
web console uses, reached over the internet at `https://<station domain>/api/…` through nginx.
Always use **HTTPS**; the tokens are bearer credentials.

## 1. Signing in

The app holds two tokens per device:

| Token   | Prefix | Lifetime (default)                                     | Use                                          |
| ------- | ------ | ------------------------------------------------------ | -------------------------------------------- |
| Access  | `rat_` | 60 min (`users.appTokens.accessTokenMinutes`)          | `Authorization: Bearer rat_…` on every call  |
| Refresh | `rrt_` | 90 days, renewed on every refresh (`refreshTokenDays`) | Get a new pair when the access token expires |

The access token acts as the signed-in user **with that user's role** (admin / operator / DJ, see
[api.md](./api.md)), so the app sees exactly what that person may do in the web console. Bearer
requests need no cookies and no CSRF token.

### a) Pairing code / QR (recommended)

The user opens **Account → Connected apps → Pair a device** in the web console. It shows an
8-character code (`ABCD-EFGH`, valid 10 min, works once) and a QR code containing:

```json
{
  "type": "radio-remote-pairing",
  "v": 1,
  "server": "https://radio.example.com",
  "code": "ABCD-EFGH"
}
```

The app scans it (or the user types the server address and code) and calls:

```http
POST /api/auth/token
Content-Type: application/json

{ "grantType": "pairing_code", "code": "ABCD-EFGH",
  "deviceName": "Pixel 9", "platform": "android", "appVersion": "1.0.0" }
```

Codes are case-insensitive and dashes/spaces are ignored. No password is typed on the phone, and it
works for accounts with two-factor authentication.

### b) Username and password

```http
POST /api/auth/token
Content-Type: application/json

{ "grantType": "password", "login": "jane", "password": "…", "totp": "123456",
  "deviceName": "Pixel 9", "platform": "android", "appVersion": "1.0.0" }
```

`totp` is only needed when the account has two-factor authentication (a recovery code also works).
If it is missing the server answers `401 totp_required`: show a code field and send the request
again.

### Response (both grants and refresh)

```json
{
  "tokenType": "Bearer",
  "accessToken": "rat_…",
  "expiresIn": 3600,
  "refreshToken": "rrt_…",
  "refreshExpiresIn": 7776000,
  "deviceId": 12,
  "user": { "id": 3, "username": "jane", "email": "…", "role": "operator", "totp_enabled": true }
}
```

Store both tokens in encrypted storage (Android Keystore-backed `EncryptedSharedPreferences` or
DataStore + Tink). Never log them.

## 2. Refreshing

When a call returns **401 with `error.code` = `invalid_token`**, the access token expired or was
revoked: refresh once, then retry the call.

```http
POST /api/auth/token
{ "grantType": "refresh_token", "refreshToken": "rrt_…", "appVersion": "1.0.1" }
```

Every refresh returns a **new refresh token**; save it and discard the old one. If an old refresh
token is ever presented again, the server assumes it was copied, signs the device out and alerts
the station (`401 token_reused`). So:

- Run at most **one refresh at a time** (single-flight). Concurrent 401s must wait for the same
  refresh, not start their own.
- Persist the new refresh token **before** using the new access token.

On `401 token_reused`, `401 invalid_token` from the refresh itself, or `403 account_disabled`, clear
the tokens and show the sign-in/pairing screen.

### OkHttp sketch (Kotlin)

```kotlin
class TokenAuthenticator(private val store: TokenStore, private val auth: AuthApi) : Authenticator {
    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.request.header("Authorization") == null) return null
        synchronized(this) {                                   // single-flight refresh
            val sent = response.request.header("Authorization")!!.removePrefix("Bearer ")
            val current = store.accessToken
            if (current != null && current != sent)            // someone else already refreshed
                return response.request.newBuilder().header("Authorization", "Bearer $current").build()
            val tokens = auth.refresh(store.refreshToken ?: return null) ?: run { store.clear(); return null }
            store.save(tokens)                                 // persist before use
            return response.request.newBuilder()
                .header("Authorization", "Bearer ${tokens.accessToken}").build()
        }
    }
}

val client = OkHttpClient.Builder()
    .addInterceptor { chain ->
        val token = store.accessToken
        chain.proceed(chain.request().newBuilder().apply {
            if (token != null) header("Authorization", "Bearer $token")
        }.build())
    }
    .authenticator(TokenAuthenticator(store, authApi))
    .build()
```

## 3. Signing out

```http
POST /api/auth/token/revoke
Authorization: Bearer rat_…
```

Or, when the access token has already expired, send `{ "refreshToken": "rrt_…" }` instead. The
answer is always `200 { "ok": true }`. Users can also sign devices out under **Account → Connected
apps** in the web console, and admins under **Users**. Changing or resetting the password, or
deactivating the account, signs all of that user's devices out.

## 4. What a remote typically calls

All with `Authorization: Bearer rat_…`. Permissions are per role; the web console's rules apply.

| Action                  | Request                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who am I                | `GET /api/auth/me`                                                                                                                                                |
| Full playout state      | `GET /api/playout/state` → `{ connected, state }`; `state` has now playing, queue, history, live, emergency, encoders, Stereo Tool                                |
| Skip / pause / resume   | `POST /api/playout/skip` · `/pause` · `/resume`                                                                                                                   |
| Stop / start automation | `POST /api/playout/stop` · `/play`                                                                                                                                |
| Replay last track       | `POST /api/playout/replay-last`                                                                                                                                   |
| Seek                    | `POST /api/playout/seek` `{ "position": 42.5 }`                                                                                                                   |
| Queue                   | `GET /api/playout/queue` · `POST /api/playout/queue/move` `{ "uid", "toIndex" }` · `DELETE /api/playout/queue/{uid}` · `POST /api/playout/queue/jump` `{ "uid" }` |
| Insert a track          | `POST /api/playout/queue/insert` `{ "mediaId": 123, "position": "next" }` (`"next"`, `"end"` or an index)                                                         |
| Cart wall (jingle now)  | `GET /api/playlists` → the `Jingles` playlist id → `GET /api/playlists/{id}` → `POST /api/playout/play-now` `{ "mediaId": 77, "kind": "jingle" }`                 |
| Voice-over              | `POST /api/playout/voice-over` `{ "mediaId": 88, "duckDb": -12 }`                                                                                                 |
| Master fader            | `PATCH /api/playout/fader` `{ "value": 0.8 }` (0–1.5)                                                                                                             |
| Emergency               | `POST /api/playout/emergency` `{ "action": "trigger" }` / `{ "action": "clear" }`                                                                                 |
| Search the library      | `GET /api/media?q=queen&limit=20`                                                                                                                                 |
| Artwork                 | `GET /api/media/{id}/artwork` (no auth needed)                                                                                                                    |
| Live (DJs)              | `POST /api/live/start` `{ "mode": "duck" }` · `POST /api/live/mode` `{ "mode": "takeover" }` · `POST /api/live/stop`                                              |
| Requests (moderation)   | `GET /api/requests` · `POST /api/requests/{id}/approve` · `/play-next` · `/reject`                                                                                |
| Alerts                  | `GET /api/alerts?active=true` · `POST /api/alerts/{id}/ack`                                                                                                       |
| Listen                  | `https://<domain>/stream/mobile.mp3` (or HLS `/hls/stream.m3u8` if enabled)                                                                                       |

The full list with permissions is in [api.md](./api.md); the OpenAPI document is at
`GET /api/docs` (bearer scheme `appToken`).

## 5. Live updates (WebSocket)

Open `wss://<domain>/ws` with the same header. OkHttp sends it on the handshake:

```kotlin
val ws = client.newWebSocket(
    Request.Builder().url("wss://radio.example.com/ws")
        .header("Authorization", "Bearer ${store.accessToken}").build(),
    listener,
)
```

The first message is `hello` (`authenticated: true`, your channels), then `playout:state`, then
events such as `playout:now-playing`, `playout:track-started`, `meter` (10 per second; skip it on
mobile with `{ "type": "subscribe", "channels": ["playout", "alerts", "requests"] }` if you don't
draw meters), `alerts:new`, `requests:new`. Send `{ "type": "ping" }` every 30 s. An open socket
stays connected after its access token expires; on reconnect, use the current token (refresh first
if it has expired).

## 6. Errors and limits

Every error has the shape `{ "error": { "code": "…", "message": "…" } }`.

| Status / code                        | Meaning → what the app does                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| 401 `invalid_token`                  | Access token expired/revoked → refresh once, retry                                 |
| 401 `token_reused`                   | Device was signed out (copied refresh token) → back to sign-in                     |
| 401 `invalid_credentials`            | Wrong username/password                                                            |
| 401 `totp_required` / `totp_invalid` | Ask for / re-ask the 2FA code                                                      |
| 400 `invalid_token` (pairing)        | Pairing code wrong, used or expired → ask for a new one                            |
| 403 `forbidden`                      | The user's role may not do this → hide/disable the control                         |
| 403 `account_disabled`               | Account deactivated → back to sign-in                                              |
| 403 `app_access_disabled`            | The station switched app access off (`users.appTokens.enabled`)                    |
| 409 `too_many_devices`               | Account has the maximum number of devices (default 10) → remove one in the console |
| 429 `rate_limited`                   | Slow down: sign-in 10/min, playout control 120/min per IP                          |
| 503 `worker_unavailable`             | Playout engine is restarting → show "reconnecting", retry                          |

## 7. Station settings

`station.json` → `users.appTokens`:

```json
{
  "enabled": true,
  "accessTokenMinutes": 60,
  "refreshTokenDays": 90,
  "pairingCodeMinutes": 10,
  "maxDevicesPerUser": 10
}
```

Sign-ins, pairings, revocations and token-reuse detections are in the audit log; actions taken
from an app are audited with its `deviceId`.
