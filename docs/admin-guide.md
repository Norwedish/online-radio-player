# Admin guide

How to run the station from the web console at `https://<domain>/admin`. Installing is in
[install.md](./install.md); fixing things at 3 a.m. is in [runbook.md](./runbook.md).

## 1. First login

1. Sign in as `admin` with the password the installer printed (also `ADMIN_PASSWORD` in
   `/etc/radio/secrets.env`).
2. _Account_ (click your name, bottom left): change the password and **turn on two-factor
   authentication** (scan the QR code with an authenticator app, confirm a code, store the
   recovery codes somewhere safe — each works once).
3. _Settings → Station_: name, tagline, colours and logo used on the public `/listen` page.
4. _Users_: create accounts for the team. Pick the role that fits:

| Role         | Can                                                                                                              | Cannot                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Admin**    | Everything                                                                                                       | —                                       |
| **Operator** | Studio (players, automation; no mic), media and playlists, schedule, requests, events, stats, alerts, recordings | Users, settings, API keys, audit log    |
| **DJ**       | Studio incl. microphone, request moderation, own shift reports; read-only media/schedule/stats/alerts            | Edit media, schedule, settings or users |

Forgotten passwords: users can use _Forgot password_ on the login page (needs SMTP); an admin can
set a new password under _Users_. Deactivating a user ends all their sessions.

### Remote-control app

Under _Account → Connected apps_, **Pair a device** shows a QR code and an 8-character code (valid
10 minutes, works once). Scan it with the remote-control app and the phone is signed in as you,
with your role; no password is typed on the phone. The same list shows each connected device and
when it was last used, with **Sign out** per device. Changing your password signs all devices
out. Admins can see every user's devices (`GET /api/admin/devices`). Developer details:
[mobile-app-api.md](./mobile-app-api.md).

## 2. Media library

Put audio in the media root (`/srv/radio/media`, or the NAS linked there). **Folder names decide
playlists**: a file is added to every playlist whose name matches a folder on its path:

```text
media/
  [PM] 07:00/   → the 07:00 hour playlist        80s/ … 90s/  → decade playlists (fallback mode)
  General/      → general rotation (fills gaps)  Jingles/     → jingles, stingers, sweepers
  Nieuws/       → news bulletins                 Emergency/   → emergency-loop.mp3
  Inbox/        → watch folder + web uploads (auto-imported)
```

- **Scan**: _Media library → Scan library_ (also runs from the CLI). New and changed files are
  read (tags, duration, format, artwork), hashed for duplicates, and missing files are marked
  `missing`. Unchanged files are skipped, so rescans are quick.
- **Watch folder**: files dropped into `Inbox/` (or copied over SMB/NFS) are imported within a
  few seconds.
- **News bulletins**: the two news files (paths in the generator settings, default
  `Nieuws/nieuws-heel-uur.mp3` and `Nieuws/nieuws-half-uur.mp3`) are checked every 10 s in
  the media root and in every enabled NAS path (`media.nasPaths`). It doesn't wait for the
  periodic scan. A replaced bulletin is re-imported and re-analysed once its size and
  modification time are the same on two checks in a row, so a new version is ready within
  about 20 s. Writers should save to a hidden temp file (for example `.nieuws-heel-uur.mp3.tmp`)
  and rename it over the old one; temp and hidden files are ignored. If the same file exists in
  more than one place, the media root wins, then the NAS paths in config order, and a warning is
  logged.
- **Upload**: drag files onto the library page (up to 500 MB each; the content must really be
  audio).
- **Loudness**: every track is measured (EBU R128) in the background and played at the station
  target (default −16 LUFS, _Settings → Audio_). Files are never modified.
- **Crossfades**: the same measurement finds where each song starts, where its ending drops
  below the crossfade threshold, and where it goes silent (_Settings → Audio → Autocue_). The
  next song starts at that crossfade point at full level, with no fade-in. How the old song
  leaves depends on how loud the new intro is compared with the old song's tail:
  - **Louder intro:** the old song fades out within 1 s.
  - **Quieter intro:** the old song plays out its own ending and fades only in the last 0.5 s,
    so no hole opens.
  - **In between:** somewhere between those two.

  A song that stops abruptly has no fade region; the next one starts the moment it ends. A song
  can also start under the fading end of the news or a jingle, but the news and jingles always
  start on their own. The overlap is capped by _max overlap_ (default 6 s). A less negative
  crossfade threshold (Liquidsoap's default is −7 dB) starts the next song earlier, while the
  old one is still clearly audible.

- **Tags**: click a track to edit artist/title/album/year, cue in/out, fades and gain, replace
  artwork, preview it, or _Look up on MusicBrainz_. Suggestions land in the _Metadata
  suggestions_ tab; apply or reject them. Tracks without tags get artist/title from an
  `Artist - Title.mp3` filename and are listed under the _missing tags_ filter.
- **Duplicates**: the _Duplicates_ tab groups identical files (same content) and near duplicates
  (same artist/title, length within 2 s). Merge (keep one; playlists, plans and history move to it and the others are disabled) or ignore.

## 3. Playlists and the 24-hour schedule

The station runs a fixed grid of **24 one-hour slots**, each fed by its own playlist
(`[PM] 00:00` … `[PM] 23:00`), with news locked at :00 and :30.

- _Playlists_: add/remove/reorder tracks; set weight and rotation; create extra playlists.
- _Schedule_: the 24 h grid. Per hour you can switch the playlist, lock it, mark it **live**
  (automation steps aside for a booked show) or disable it.
- _Schedule → Template_: separation rules (same track 4 h, same artist 1 h by default), hour
  length window, overrun tolerance, news length reserve.
- The generator builds plans automatically: hour 0 of tomorrow at 23:00, the rest at 00:05, and
  whenever an upcoming hour lacks a plan. **Generate** (with _dry run_ preview) rebuilds on
  demand; the on-air hour and past hours are never rewritten. _Runs_ shows what each run did.
- **Fallback mode** draws from the decade playlists + General when hour playlists are thin.
- **Boundary log**: how each :00/:30 news join went (cut, let finish, early/late news) and by how
  much. The tolerance is _Settings → Audio → Boundary tolerance_ (default 45 s).

## 4. Studio

_Studio_ is one console for automated and manual operation: two on-air players, cart pads, a
headphone pre-listen player, the automation queue, the microphone, the mixer, and encoder/Stereo
Tool status. (The old _Playout_ and _Live studio_ addresses open the Studio.)

**Library drawer**: the song browser at the bottom of the screen, over the studio. When it is
closed, only the **Library** tab shows in the bottom-right corner. _Load_, _Queue a track_ and
_Find_ open it with the search box ready. It remembers whether you left it open, and you can drag
its top edge to resize it.

- **Search** the whole library: artist, title, album or folder. More results load as you scroll.
- **Filter** by playlist (for example _Nieuws_ for the bulletins, or a decade) and sort by artist,
  title, recently added or length.
- **Drag** a track onto player A or B to load it, or between queue items to insert it there. Below
  the last item adds it at the end. While you drag, the drawer fades and lets the pointer through,
  so you can drop on the queue under it.
- Or use the row buttons: 🎧 pre-listen (or double-click the row), **A** / **B** load, and _Queue
  next_.

**Automation** (the station runs itself):

- Transport: **Skip**, **Pause/Resume**, **Stop/Start automation**, **Replay last**.
- Keyboard: **Space** pause/resume, **→** skip, **R** replay last (not while typing in a field).
- Queue: drag to reorder, remove, _Jump_ (▶) to an item, 🎧 pre-listen, or **A**/**B** to take the
  item out of the queue and load it into a player. Add tracks from the library drawer.
- **Voice-over**: plays a short file over the music with ducking.

**Players A and B** (manual operation):

- **Load** a track from the library drawer (drag it onto the player, or press A/B on a library or
  queue row). The player shows remaining and elapsed
  time, an **intro** countdown (to where the vocals start), an **outro** countdown, the **cue
  point** and the **loop** length. Click the progress bar (or use ←/→ on it) to seek.
- **Play/Pause**, **Stop** (back to the cue point), **Fade** (3 s fade-out, then back to cue),
  **Cue here** (set the cue point to the current position), **Loop** (repeat from the cue point),
  **Auto-next** (when this player ends or starts fading, the other player starts — a hand-made
  crossfade), a per-player **fader** (double-click for 0 dB) and level meter.
- Keyboard: **1** / **2** play or pause player A / B.
- **Manual mode**: pressing play on a player takes over from automation — the automation track
  fades out and is held. **Hand back to automation** fades the players out; automation resumes the
  held track (or rejoins the schedule if a news boundary has passed). _Take manual control_ does the
  same without starting a player. In manual mode 60 s of silence hands back automatically.
- Intro/outro markers are set per track in _Media library → track → Intro end / Outro start_; the
  crosshair button takes the position from the preview player.

**Cart pads** fire jingles/sweepers from a playlist (Jingles by default) on top of whatever is on
air, without taking over; a playing pad lights up — press it again to stop it.

**Pre-listen** plays a track in your browser only (listeners never hear it), honouring cue in/out,
on a separate output device where the browser supports it. **To A / To B** loads it into a player
starting at the position you reached. Drag a track from the library drawer, or an item from the
queue (the locked news too), onto _Pre-listen_ to hear it. Drag the pre-listen track by its title
onto player A or B to load it from the position you reached, or into the queue.

**Direct monitor** lets you hear the studio mix _before_ Stereo Tool, about 150 ms behind (the
listener stream is processed and several seconds behind). Start it in _Studio → Direct monitor_,
or pick _Direct (no processing)_ in the header player — it keeps playing on every page. Your own
mic is left out by default (hearing yourself delayed is disorienting); switch _Include my
microphone_ on to hear exactly what goes into Stereo Tool. _Light 24 kHz_ halves the bandwidth
(≈0.8 Mbit/s instead of 1.5); raise _Delay_ if you hear dropouts on a slow connection. Starting
the monitor stops the header's stream player and the other way round.

**Mixer**: master and per-bus meters (the _Studio_ bus carries the players and carts; it ducks
under the mic like automation), and the **master fader**.

**Emergency**: switches to the emergency loop; clear it to return to automation. The worker also
does this by itself after `audio.silenceSeconds` of silence (automation mode).

## 5. Going live

**From the browser (Studio → Microphone).** Pick your microphone, set the gain until the meter peaks
around −6 dB, choose **Duck music** (music continues quietly under you) or **Takeover** (music
stops), tick _Record this session_ if wanted, then **Go live** — a 3-second countdown starts the
uplink. Use _Pre-listen_ to cue what's coming. **End live** returns to automation; your
shift report (duration, tracks, requests) appears under _Stats_.

Use headphones: the studio page never plays the station stream back into your microphone.

**From external software (Mixxx, BUTT, OBS, a hardware encoder).** Stream to the Icecast live
mount through the site:

- Server `https://<domain>/stream/live` (Icecast "PUT" source over HTTPS), or tunnel to the host
  and use `127.0.0.1:8000`, mount `/live`.
- User `source`, password `ICECAST_LIVE_PASSWORD` from `secrets.env`.
- 48 kHz stereo, MP3 or Ogg. When the source connects the worker ducks or takes over per
  _Settings → Live_; when it disconnects, automation resumes.

Recordings are FLAC files (see _Stats_ / the recordings API), kept for 30 days.

## 6. Requests

Listeners request songs on `/listen` (library search, or free text that needs moderation), with
an optional message/dedication. _Requests_ is the moderation queue: **Approve** (scheduled into
the next hour), **Play next**, **Reject**, or **Link** a free-text request to a library track.
_Settings → Requests_: auto-approve, per-IP cooldown (default 60 min), hourly cap, profanity
filter, and the blacklist (artists/titles/words). Listeners see their request's status.

## 7. Events and triggers

- _Events_: timed overrides with a start/end time and a priority (1–10): a **playlist** event
  replaces automation with that playlist, a **live** event reserves the air for a show, a
  **stinger** event fires a jingle. Higher priority wins; start/stop any event by hand.
- _Settings → Triggers_: map buttons (Stream Deck, MIDI bridges, home automation) to actions
  (skip, jingle, emergency, …). Hardware calls `POST /api/triggers/<id>` with an API key that
  has the `triggers:fire` scope (_Users → API keys_).

## 8. Alerts, stats and status

- _Alerts_: active and past alerts; acknowledge when handled. Recipients, webhooks and syslog are
  configured in _Settings → Alerts_ and `station.json`; **Send test alert** checks every channel.
- _Stats_: listeners over time per mount, play history, airplay analytics (most played,
  by hour), DJ shift reports — each exportable as CSV.
- _Dashboard_: on-air summary, listeners, encoders, Stereo Tool (processing/bypassed), the next
  boundary, recent alerts.
- _Settings → Outputs_: the Icecast mounts and Stereo Tool status (read-only; mounts are
  changed in `station.json`, see the runbook).

## 9. Backups and retention

- _Settings → Backups_: nightly backups (03:15, 14 daily + 8 weekly), **Back up now**, list of
  files. Restoring is a shell operation (runbook).
- _Settings → Retention_: how long play history (90 days), logs (30), requests (30) and
  recordings (30) are kept.

## 10. Partner API

Give partners an API key with `public:stats` for listener figures, or point them at the public
endpoints (now playing, schedule, history) — see [api.md](./api.md) and `/api/docs`.
