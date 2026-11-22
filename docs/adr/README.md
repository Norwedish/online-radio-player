# Architecture Decision Records

ADRs capture decisions that are expensive to reverse. Each spike in M0 produces one.

| ADR                                    | Title                                | Status                        |
| -------------------------------------- | ------------------------------------ | ----------------------------- |
| [0001](./0001-ffmpeg-pcm-chain.md)     | FFmpeg PCM chain                     | Accepted                      |
| [0002](./0002-stereotool-transport.md) | Thimeo Stereo Tool transport         | Accepted (flags pending M0.5) |
| [0003](./0003-icecast-hls.md)          | HLS output (FFmpeg + nginx)          | Accepted                      |
| [0004](./0004-live-transport.md)       | Live DJ transport (WS PCM + Icecast) | Accepted                      |
| [0005](./0005-sqlite-wal.md)           | SQLite WAL concurrency               | Accepted                      |

Use [`0000-template.md`](./0000-template.md) for new ADRs.
