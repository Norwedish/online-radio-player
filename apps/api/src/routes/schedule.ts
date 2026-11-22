/** Schedule grid, overrides, generator and plans (PLAN §6.7, M3.7, M10.1–M10.2). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { stationNow } from "@radio/core";
import {
  generatorSettingsSchema,
  hourOverrideSchema,
  SCHEDULE_KEYS,
  templateBlockSchema,
} from "@radio/shared";
import type { AppContext } from "../context.js";
import { HttpError, audit, guard, notFound, parse } from "../http.js";

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function scheduleRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { repos, generator } = ctx;

  app.get(
    "/api/schedule",
    {
      preHandler: guard("schedule:view"),
      config: { summary: "24h grid + overrides + plan status", tags: ["schedule"] },
    },
    async (req) => {
      const q = parse(z.object({ date: dateParam.optional() }), req.query);
      const now = stationNow(generator.tz);
      const date = q.date ?? now.date;
      const slots = repos.schedule.slots();
      const plans = new Map(repos.schedule.plansForDate(date).map((p) => [p.hour, p]));
      const overrides = generator.overrides();
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const slot = slots.find((s) => s.hour === hour);
        const plan = plans.get(hour);
        const override = {
          ...(overrides[String(hour)] ?? {}),
          ...(overrides[`${date}:${hour}`] ?? {}),
        };
        return {
          hour,
          slot: slot
            ? {
                id: slot.id,
                playlistId: slot.playlist_id,
                playlistName: slot.playlist_name,
                enabled: slot.enabled,
                days: slot.days,
              }
            : null,
          override,
          plan: plan
            ? {
                id: plan.id,
                status: plan.status,
                totalSeconds: plan.total_seconds,
                warnings: plan.warnings,
                generatedAt: plan.generated_at,
              }
            : null,
          isCurrent: date === now.date && hour === now.hour,
        };
      });
      return { date, timezone: generator.tz, fallbackMode: generator.fallbackMode(), now, hours };
    },
  );

  app.patch(
    "/api/schedule/:hour",
    {
      preHandler: guard("schedule:manage"),
      config: { summary: "Update hour override/lock/live or its playlist", tags: ["schedule"] },
    },
    async (req) => {
      const { hour } = parse(
        z.object({ hour: z.coerce.number().int().min(0).max(23) }),
        req.params,
      );
      const body = parse(
        z.object({
          override: hourOverrideSchema.nullable().optional(),
          date: dateParam.optional(),
          playlistId: z.number().int().optional(),
          slotEnabled: z.boolean().optional(),
        }),
        req.body,
      );
      if (body.playlistId !== undefined || body.slotEnabled !== undefined) {
        const slot = repos.schedule.slots().find((s) => s.hour === hour);
        if (!slot) throw notFound("schedule slot");
        if (body.playlistId !== undefined && !repos.playlists.get(body.playlistId))
          throw notFound("playlist");
        repos.schedule.updateSlot(slot.id, {
          ...(body.playlistId !== undefined ? { playlist_id: body.playlistId } : {}),
          ...(body.slotEnabled !== undefined ? { enabled: body.slotEnabled } : {}),
        });
      }
      if (body.override !== undefined) {
        if (body.override?.playlistName && !repos.playlists.getByName(body.override.playlistName))
          throw notFound(`playlist ${body.override.playlistName}`);
        generator.setOverride(hour, body.override, body.date);
      }
      audit(ctx, req, "schedule.update", "schedule_slot", hour, body);
      return {
        ok: true,
        override: generator.overrideFor(body.date ?? stationNow(generator.tz).date, hour),
      };
    },
  );

  app.post(
    "/api/schedule/fallback-mode",
    {
      preHandler: guard("schedule:manage"),
      config: { summary: "Toggle fallback (decades + news) mode", tags: ["schedule"] },
    },
    async (req) => {
      const body = parse(
        z.object({ enabled: z.boolean(), regenerate: z.boolean().default(true) }),
        req.body,
      );
      generator.setFallbackMode(body.enabled);
      audit(ctx, req, "schedule.fallback_mode", null, null, body);
      const result = body.regenerate ? generator.generate({ runType: "fallback-toggle" }) : null;
      return {
        fallbackMode: body.enabled,
        regenerated: result?.plans.filter((p) => !p.skipped).length ?? 0,
      };
    },
  );

  app.post(
    "/api/schedule/generate",
    {
      preHandler: guard("schedule:manage"),
      config: { summary: "Generate plans (or dry-run preview)", tags: ["schedule"] },
    },
    async (req) => {
      const body = parse(
        z.object({
          date: dateParam.optional(),
          hours: z.array(z.number().int().min(0).max(23)).optional(),
          dryRun: z.boolean().default(false),
          force: z.boolean().default(false),
        }),
        req.body,
      );
      const result = generator.generate({ ...body, runType: body.dryRun ? "preview" : "manual" });
      if (!body.dryRun)
        audit(ctx, req, "schedule.generate", null, null, {
          date: body.date,
          hours: body.hours,
          runId: result.runId,
        });
      return result;
    },
  );

  app.get(
    "/api/schedule/template",
    {
      preHandler: guard("schedule:view"),
      config: { summary: "Hour template + generator settings", tags: ["schedule"] },
    },
    async () => ({ template: generator.template(), settings: generator.settings() }),
  );

  app.patch(
    "/api/schedule/template",
    {
      preHandler: guard("schedule:manage"),
      config: { summary: "Update hour template / generator settings", tags: ["schedule"] },
    },
    async (req) => {
      const body = parse(
        z.object({
          template: z.array(templateBlockSchema).min(1).max(20).optional(),
          settings: generatorSettingsSchema.partial().optional(),
        }),
        req.body,
      );
      if (body.template) {
        const sorted = [...body.template].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i += 1)
          if (sorted[i]!.start < sorted[i - 1]!.end)
            throw new HttpError(400, "validation_error", "template blocks overlap");
        repos.schedule.setSetting(SCHEDULE_KEYS.templateBase, sorted);
      }
      if (body.settings) {
        const { fallback_mode: _f, ...rest } = body.settings;
        repos.schedule.setSetting(SCHEDULE_KEYS.generator, { ...generator.settings(), ...rest });
      }
      audit(ctx, req, "schedule.template", null, null, body);
      return { template: generator.template(), settings: generator.settings() };
    },
  );

  app.get(
    "/api/schedule/runs",
    {
      preHandler: guard("schedule:view"),
      config: { summary: "Generator runs", tags: ["schedule"] },
    },
    async () => ({ items: repos.schedule.runs(50) }),
  );

  app.get(
    "/api/schedule/boundary-log",
    {
      preHandler: guard("schedule:view"),
      config: { summary: "Boundary decisions (default: last 24 h)", tags: ["schedule"] },
    },
    async (req) => {
      const q = parse(
        z.object({
          since: z.string().optional(),
          limit: z.coerce.number().int().max(1000).optional(),
        }),
        req.query,
      );
      return {
        items: repos.schedule.boundaryEvents(
          q.since ?? new Date(Date.now() - 86_400_000).toISOString(),
          q.limit ?? 200,
        ),
      };
    },
  );

  app.get(
    "/api/plans",
    {
      preHandler: guard("schedule:view"),
      config: { summary: "Plans for a date", tags: ["schedule"] },
    },
    async (req) => {
      const q = parse(z.object({ date: dateParam.optional() }), req.query);
      const date = q.date ?? stationNow(generator.tz).date;
      return { date, items: repos.schedule.plansForDate(date).map(({ snapshot: _s, ...p }) => p) };
    },
  );

  app.get(
    "/api/plans/:date/:hour",
    {
      preHandler: guard("schedule:view"),
      config: { summary: "One hour plan with items", tags: ["schedule"] },
    },
    async (req) => {
      const p = parse(
        z.object({ date: dateParam, hour: z.coerce.number().int().min(0).max(23) }),
        req.params,
      );
      const plan = repos.schedule.plan(p.date, p.hour);
      if (!plan) throw notFound("plan");
      const items = repos.schedule.items(plan.id);
      const media = new Map(
        repos.media
          .getMany(items.map((i) => i.media_id).filter((x): x is number => x !== null))
          .map((m) => [m.id, m]),
      );
      return {
        plan: {
          ...plan,
          snapshot: undefined,
          mode: (plan.snapshot as { mode?: string } | null)?.mode ?? null,
          pools: (plan.snapshot as { pools?: string[] } | null)?.pools ?? [],
        },
        items: items.map((i) => ({
          ...i,
          album: media.get(i.media_id ?? -1)?.album ?? null,
          artworkUrl:
            i.media_id && media.get(i.media_id)?.artwork_path
              ? `/api/media/${i.media_id}/artwork`
              : null,
        })),
        boundary: repos.schedule.boundaryEvents("0000").filter((b) => b.plan_id === plan.id),
      };
    },
  );

  app.post(
    "/api/plans/:date/:hour/regenerate",
    {
      preHandler: guard("schedule:manage"),
      config: { summary: "Regenerate one hour", tags: ["schedule"] },
    },
    async (req) => {
      const p = parse(
        z.object({ date: dateParam, hour: z.coerce.number().int().min(0).max(23) }),
        req.params,
      );
      const result = generator.generate({ date: p.date, hours: [p.hour], runType: "regenerate" });
      const plan = result.plans[0]!;
      if (plan.skipped) throw new HttpError(409, "guarded", plan.skipped);
      audit(ctx, req, "schedule.regenerate", "hourly_plan", plan.planId, p);
      return plan;
    },
  );
}
