/** Media library + playlists (PLAN §6.7, M2.6–M2.8, M10.2–M10.3). */
import type { FastifyInstance } from "fastify";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { HttpError, audit, guard, idParam, notFound, parse } from "../http.js";
import { analyzeMedia } from "../services/media/loudness.js";
import { applySuggestion, suggestForMedia } from "../services/media/metadata-lookup.js";
import { saveArtwork } from "../services/media/probe.js";
import { importFile, mediaRoots, scanLibrary } from "../services/media/scanner.js";

const MAX_UPLOAD = 500 * 1024 * 1024;
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#111915"/><circle cx="150" cy="150" r="90" fill="none" stroke="#22c55e" stroke-width="10" opacity=".6"/><circle cx="150" cy="150" r="22" fill="#22c55e" opacity=".8"/></svg>`;

/** Magic-byte sniffing for audio uploads (M2.6, §6.10). */
export function sniffAudio(header: Buffer): string | null {
  const ascii = header.toString("latin1");
  if (ascii.startsWith("ID3") || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0))
    return "audio/mpeg";
  if (ascii.startsWith("fLaC")) return "audio/flac";
  if (ascii.startsWith("OggS")) return "audio/ogg";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return "audio/wav";
  if (ascii.slice(4, 8) === "ftyp") return "audio/mp4";
  if (header[0] === 0xff && (header[1]! & 0xf6) === 0xf0) return "audio/aac";
  return null;
}

const mediaQuery = z.object({
  q: z.string().max(200).optional(),
  artist: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  album: z.string().max(200).optional(),
  status: z.enum(["ok", "missing", "processing", "error", "disabled"]).optional(),
  minDuration: z.coerce.number().optional(),
  maxDuration: z.coerce.number().optional(),
  minLufs: z.coerce.number().optional(),
  maxLufs: z.coerce.number().optional(),
  duplicates: z.coerce.boolean().optional(),
  missingTags: z.coerce.boolean().optional(),
  playlistId: z.coerce.number().int().optional(),
  pathPrefix: z.string().max(300).optional(),
  sort: z.enum(["artist", "title", "album", "duration", "created_at", "loudness_lufs"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const tagPatch = z.object({
  title: z.string().max(300).nullable().optional(),
  artist: z.string().max(300).nullable().optional(),
  artist_sort: z.string().max(300).nullable().optional(),
  album: z.string().max(300).nullable().optional(),
  album_artist: z.string().max(300).nullable().optional(),
  genre: z.string().max(100).nullable().optional(),
  year: z.number().int().min(1800).max(2100).nullable().optional(),
});

const mediaPatch = tagPatch.extend({
  cue_in: z.number().min(0).nullable().optional(),
  cue_out: z.number().min(0).nullable().optional(),
  fade_in: z.number().min(0).max(30).nullable().optional(),
  fade_out: z.number().min(0).max(30).nullable().optional(),
  gain_db: z.number().min(-30).max(20).nullable().optional(),
  status: z.enum(["ok", "disabled"]).optional(),
});

export async function libraryRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos } = ctx;
  let scanRunning = false;

  app.get(
    "/api/media",
    {
      preHandler: guard("media:view"),
      config: { summary: "Search/filter media", tags: ["media"] },
    },
    async (req) => repos.media.search(parse(mediaQuery, req.query)),
  );

  app.get(
    "/api/media/stats",
    {
      preHandler: guard("media:view"),
      config: { summary: "Library counts by status", tags: ["media"] },
    },
    async () => ({
      byStatus: repos.media.stats(),
      total: repos.media.count(),
      watcher: ctx.watcher.status,
      scanRunning,
      roots: mediaRoots(ctx.config),
    }),
  );

  app.get(
    "/api/media/duplicates",
    { preHandler: guard("media:view"), config: { summary: "Duplicate groups", tags: ["media"] } },
    async () => ({ groups: repos.media.duplicateGroups() }),
  );

  app.post(
    "/api/media/duplicates/merge",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Merge a duplicate group", tags: ["media"] },
    },
    async (req) => {
      const body = parse(
        z.object({
          keepId: z.number().int(),
          removeIds: z.array(z.number().int()).min(1).max(1000),
        }),
        req.body,
      );
      repos.media.mergeDuplicates(body.keepId, body.removeIds);
      audit(ctx, req, "media.merge", "media", body.keepId, body);
      return { ok: true };
    },
  );

  app.post(
    "/api/media/duplicates/ignore",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Ignore a duplicate group", tags: ["media"] },
    },
    async (req) => {
      const body = parse(
        z.object({ kind: z.enum(["hash", "metadata"]), key: z.string().max(500) }),
        req.body,
      );
      repos.media.ignoreDuplicateGroup(`${body.kind === "hash" ? "hash" : "meta"}:${body.key}`);
      audit(ctx, req, "media.duplicates_ignore", null, null, body);
      return { ok: true };
    },
  );

  app.post(
    "/api/media/import",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Start a folder scan", tags: ["media"] },
    },
    async (req, reply) => {
      if (scanRunning) throw new HttpError(409, "scan_running", "a scan is already running");
      scanRunning = true;
      audit(ctx, req, "media.scan");
      void scanLibrary(repos, ctx.config, { log: ctx.log })
        .then((r) =>
          ctx.bus.publish("media", "media:scan-done", { ...r, errors: r.errors.slice(0, 20) }),
        )
        .catch((e) => ctx.log(`scan failed: ${(e as Error).message}`))
        .finally(() => (scanRunning = false));
      return reply.status(202).send({ started: true });
    },
  );

  app.post(
    "/api/media/upload",
    {
      preHandler: guard("media:manage"),
      bodyLimit: MAX_UPLOAD,
      config: { summary: "Multipart upload into media/Inbox", tags: ["media"] },
    },
    async (req, reply) => {
      const file = await req.file({ limits: { fileSize: MAX_UPLOAD } });
      if (!file) throw new HttpError(400, "no_file", "multipart field 'file' is required");
      const ext = extname(file.filename).toLowerCase();
      if (!ctx.config.media.extensions.includes(ext))
        throw new HttpError(415, "unsupported_type", `extension ${ext || "(none)"} is not allowed`);
      mkdirSync(ctx.config.uploadsDir, { recursive: true });
      const tmp = join(ctx.config.uploadsDir, `.upload-${randomUUID()}${ext}`);
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) {
        unlinkSync(tmp);
        throw new HttpError(413, "too_large", "file exceeds the 500 MB limit");
      }
      const header = Buffer.alloc(16);
      const fd = openSync(tmp, "r");
      readSync(fd, header, 0, 16, 0);
      closeSync(fd);
      const sniffed = sniffAudio(header);
      if (!sniffed) {
        unlinkSync(tmp);
        throw new HttpError(
          415,
          "unsupported_type",
          "file content is not a recognised audio format",
        );
      }
      // Random filename, original name kept in tags (§6.10: store outside the web root).
      const safeBase = file.filename
        .replace(/[^\w .()-]+/g, "_")
        .slice(0, 120)
        .replace(/\.[^.]+$/, "");
      const finalPath = join(
        ctx.config.uploadsDir,
        `${safeBase}-${randomUUID().slice(0, 8)}${ext}`,
      );
      renameSync(tmp, finalPath);
      const { row } = await importFile(repos, ctx.config, finalPath, mediaRoots(ctx.config), {
        force: true,
      });
      repos.media.update(row.id, {
        tags: {
          ...(row.tags as Record<string, unknown>),
          originalFilename: file.filename,
          uploadedBy: req.auth.user!.username,
          mime: sniffed,
        },
      });
      void analyzeMedia(
        repos,
        row.id,
        repos.settings.get("audio.targetLufs", ctx.config.audio.targetLufs),
      ).catch(() => {});
      audit(ctx, req, "media.upload", "media", row.id, {
        filename: file.filename,
        size: statSync(finalPath).size,
      });
      ctx.bus.publish("media", "media:imported", { ids: [row.id] });
      return reply.status(201).send({ media: repos.media.get(row.id) });
    },
  );

  app.get(
    "/api/media/suggestions",
    {
      preHandler: guard("media:view"),
      config: { summary: "Pending metadata suggestions", tags: ["media"] },
    },
    async () => ({ items: repos.media.listSuggestions() }),
  );

  app.post(
    "/api/media/suggestions/:id/apply",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Apply a metadata suggestion", tags: ["media"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      applySuggestion(repos, id);
      audit(ctx, req, "media.suggestion_apply", "metadata_suggestion", id);
      return { ok: true };
    },
  );

  app.post(
    "/api/media/suggestions/:id/reject",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Reject a metadata suggestion", tags: ["media"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      repos.media.resolveSuggestion(id, "rejected");
      audit(ctx, req, "media.suggestion_reject", "metadata_suggestion", id);
      return { ok: true };
    },
  );

  app.get(
    "/api/media/:id",
    { preHandler: guard("media:view"), config: { summary: "Get media", tags: ["media"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const media = repos.media.get(id);
      if (!media) throw notFound("media");
      return {
        media,
        playlists: repos.playlists
          .list()
          .filter((p) => repos.playlists.items(p.id).some((i) => i.media_id === id))
          .map((p) => ({ id: p.id, name: p.name })),
      };
    },
  );

  app.patch(
    "/api/media/:id",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Edit media (tags, cue/fade, gain, status)", tags: ["media"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(mediaPatch, req.body);
      if (!repos.media.get(id)) throw notFound("media");
      const media = repos.media.update(id, body as Record<string, never>);
      audit(ctx, req, "media.update", "media", id, body);
      return { media };
    },
  );

  app.patch(
    "/api/media/:id/tags",
    { preHandler: guard("media:manage"), config: { summary: "Edit tags", tags: ["media"] } },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(tagPatch, req.body);
      const existing = repos.media.get(id);
      if (!existing) throw notFound("media");
      const media = repos.media.update(id, {
        ...(body as Record<string, never>),
        tags: {
          ...existing.tags,
          edited: true,
          tagsMissing: !(body.title ?? existing.title) || !(body.artist ?? existing.artist),
        },
      });
      audit(ctx, req, "media.tags", "media", id, body);
      return { media };
    },
  );

  app.delete(
    "/api/media/:id",
    {
      preHandler: guard("media:manage"),
      config: {
        summary: "Delete media row (file untouched; disabled if it has history)",
        tags: ["media"],
      },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!repos.media.delete(id)) throw notFound("media");
      audit(ctx, req, "media.delete", "media", id);
      return { ok: true };
    },
  );

  app.get(
    "/api/media/:id/artwork",
    { config: { summary: "Artwork bytes (public, placeholder when absent)", tags: ["media"] } },
    async (req, reply) => {
      // id 0 is the public placeholder.
      const { id } = parse(z.object({ id: z.coerce.number().int().min(0) }), req.params);
      const media = id > 0 ? repos.media.get(id) : undefined;
      reply.header("cache-control", "public, max-age=86400");
      if (!media?.artwork_path || !existsSync(media.artwork_path))
        return reply.type("image/svg+xml").send(PLACEHOLDER_SVG);
      const ext = extname(media.artwork_path).slice(1).toLowerCase();
      return reply
        .type(
          ext === "png"
            ? "image/png"
            : ext === "webp"
              ? "image/webp"
              : ext === "gif"
                ? "image/gif"
                : "image/jpeg",
        )
        .send(createReadStream(media.artwork_path));
    },
  );

  app.put(
    "/api/media/:id/artwork",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Replace artwork (multipart image)", tags: ["media"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const media = repos.media.get(id);
      if (!media) throw notFound("media");
      const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
      if (!file) throw new HttpError(400, "no_file", "multipart field 'file' is required");
      const data = await file.toBuffer();
      const format =
        data.subarray(0, 4).toString("latin1") === "\x89PNG"
          ? "image/png"
          : data[0] === 0xff && data[1] === 0xd8
            ? "image/jpeg"
            : data.subarray(8, 12).toString("latin1") === "WEBP"
              ? "image/webp"
              : null;
      if (!format)
        throw new HttpError(415, "unsupported_type", "artwork must be PNG, JPEG or WebP");
      const path = saveArtwork(
        ctx.config.media.artworkDir,
        `${media.hash ?? media.id}-${Date.now()}`,
        { data, format },
      );
      repos.media.update(id, { artwork_path: path });
      audit(ctx, req, "media.artwork", "media", id);
      return { media: repos.media.get(id) };
    },
  );

  app.get(
    "/api/media/:id/preview",
    {
      preHandler: guard("media:view"),
      config: { summary: "Stream the audio file (cue/next-track preview, M8.6)", tags: ["media"] },
    },
    async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const media = repos.media.get(id);
      if (!media || !existsSync(media.path)) throw notFound("media file");
      const size = statSync(media.path).size;
      const type =
        {
          ".mp3": "audio/mpeg",
          ".flac": "audio/flac",
          ".ogg": "audio/ogg",
          ".opus": "audio/ogg",
          ".wav": "audio/wav",
          ".m4a": "audio/mp4",
          ".aac": "audio/aac",
        }[extname(media.path).toLowerCase()] ?? "application/octet-stream";
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
      reply.header("accept-ranges", "bytes").type(type);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        reply
          .status(206)
          .header("content-range", `bytes ${start}-${end}/${size}`)
          .header("content-length", String(end - start + 1));
        return reply.send(createReadStream(media.path, { start, end }));
      }
      reply.header("content-length", String(size));
      return reply.send(createReadStream(media.path));
    },
  );

  app.post(
    "/api/media/:id/analyze",
    {
      preHandler: guard("media:manage"),
      config: { summary: "Re-run loudness analysis", tags: ["media"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!repos.media.get(id)) throw notFound("media");
      const result = await analyzeMedia(
        repos,
        id,
        repos.settings.get("audio.targetLufs", ctx.config.audio.targetLufs),
      );
      audit(ctx, req, "media.analyze", "media", id, result);
      return { result, media: repos.media.get(id) };
    },
  );

  app.post(
    "/api/media/:id/lookup",
    {
      preHandler: guard("media:manage"),
      config: { summary: "MusicBrainz lookup → suggestions", tags: ["media"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      if (!ctx.config.media.metadataLookup.musicbrainz)
        throw new HttpError(403, "disabled", "metadata lookup is disabled");
      const added = await suggestForMedia(repos, id);
      return { added, items: repos.media.listSuggestions().filter((s) => s.media_id === id) };
    },
  );

  /* ── Playlists ────────────────────────────────────────────────────── */

  const playlistBody = z.object({
    name: z.string().min(1).max(100),
    role: z.enum(["music", "news", "jingle", "general", "decade"]),
    rotation: z.string().max(40).nullable().optional(),
    weight: z.number().min(0).max(100).optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  });

  app.get(
    "/api/playlists",
    { preHandler: guard("media:view"), config: { summary: "List playlists", tags: ["playlists"] } },
    async () => ({ items: repos.playlists.list() }),
  );

  app.post(
    "/api/playlists",
    {
      preHandler: guard("playlists:manage"),
      config: { summary: "Create playlist", tags: ["playlists"] },
    },
    async (req, reply) => {
      const body = parse(playlistBody, req.body);
      if (repos.playlists.getByName(body.name))
        throw new HttpError(409, "conflict", "a playlist with that name exists");
      const pl = repos.playlists.create({ ...body, isJingle: body.role === "jingle" });
      audit(ctx, req, "playlist.create", "playlist", pl.id, body);
      return reply.status(201).send({ playlist: pl });
    },
  );

  app.get(
    "/api/playlists/:id",
    {
      preHandler: guard("media:view"),
      config: { summary: "Playlist with items", tags: ["playlists"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const playlist = repos.playlists.get(id);
      if (!playlist) throw notFound("playlist");
      return { playlist, items: repos.playlists.items(id) };
    },
  );

  app.patch(
    "/api/playlists/:id",
    {
      preHandler: guard("playlists:manage"),
      config: { summary: "Update playlist", tags: ["playlists"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(playlistBody.partial(), req.body);
      if (!repos.playlists.get(id)) throw notFound("playlist");
      const pl = repos.playlists.update(id, {
        ...(body.name ? { name: body.name } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.rotation !== undefined ? { rotation: body.rotation } : {}),
        ...(body.weight !== undefined ? { weight: body.weight } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.sortOrder !== undefined ? { sort_order: body.sortOrder } : {}),
      });
      audit(ctx, req, "playlist.update", "playlist", id, body);
      return { playlist: pl };
    },
  );

  app.delete(
    "/api/playlists/:id",
    {
      preHandler: guard("playlists:manage"),
      config: { summary: "Delete playlist", tags: ["playlists"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      try {
        if (!repos.playlists.delete(id)) throw notFound("playlist");
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(409, "conflict", (e as Error).message);
      }
      audit(ctx, req, "playlist.delete", "playlist", id);
      return { ok: true };
    },
  );

  app.put(
    "/api/playlists/:id/items",
    {
      preHandler: guard("playlists:manage"),
      config: { summary: "Replace items (ordered)", tags: ["playlists"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(
        z.object({
          items: z
            .array(
              z.object({
                mediaId: z.number().int(),
                weight: z.number().min(0).max(100).optional(),
              }),
            )
            .max(20_000),
        }),
        req.body,
      );
      if (!repos.playlists.get(id)) throw notFound("playlist");
      repos.playlists.replaceItems(id, body.items);
      audit(ctx, req, "playlist.items_replace", "playlist", id, { count: body.items.length });
      return { items: repos.playlists.items(id) };
    },
  );

  app.post(
    "/api/playlists/:id/items",
    {
      preHandler: guard("playlists:manage"),
      config: { summary: "Append media to a playlist", tags: ["playlists"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(
        z.object({ mediaIds: z.array(z.number().int()).min(1).max(5000) }),
        req.body,
      );
      if (!repos.playlists.get(id)) throw notFound("playlist");
      const added = repos.playlists.addItems(id, body.mediaIds);
      audit(ctx, req, "playlist.items_add", "playlist", id, { added });
      return { added };
    },
  );

  app.delete(
    "/api/playlists/:id/items/:mediaId",
    {
      preHandler: guard("playlists:manage"),
      config: { summary: "Remove one media from a playlist", tags: ["playlists"] },
    },
    async (req) => {
      const p = parse(
        z.object({ id: z.coerce.number().int(), mediaId: z.coerce.number().int() }),
        req.params,
      );
      if (!repos.playlists.removeItem(p.id, p.mediaId)) throw notFound("playlist item");
      audit(ctx, req, "playlist.item_remove", "playlist", p.id, { mediaId: p.mediaId });
      return { ok: true };
    },
  );

  app.post(
    "/api/playlists/:id/items/reorder",
    {
      preHandler: guard("playlists:manage"),
      config: { summary: "Reorder items", tags: ["playlists"] },
    },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(z.object({ mediaIds: z.array(z.number().int()).max(20_000) }), req.body);
      repos.playlists.reorder(id, body.mediaIds);
      audit(ctx, req, "playlist.reorder", "playlist", id);
      return { items: repos.playlists.items(id) };
    },
  );
}
