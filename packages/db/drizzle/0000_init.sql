CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`acknowledged_at` text,
	`acknowledged_by` integer,
	`resolved_at` text,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acknowledged_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alerts_station_created_at` ON `alerts` (`station_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alerts_station_type` ON `alerts` (`station_id`,`type`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_by` integer,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` integer,
	`metadata_json` text,
	`ip` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_station_created_at` ON `audit_log` (`station_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`type` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`verified_at` text
);
--> statement-breakpoint
CREATE TABLE `boundary_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`plan_id` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`boundary_at` text NOT NULL,
	`action` text NOT NULL,
	`deviation_ms` integer DEFAULT 0 NOT NULL,
	`details_json` text,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `hourly_plans`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "boundary_events_action" CHECK(action IN ('cut', 'let_finish', 'early_news', 'late_news', 'none'))
);
--> statement-breakpoint
CREATE INDEX `boundary_events_station_occurred_at` ON `boundary_events` (`station_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`playlist_id` integer,
	`status` text NOT NULL,
	`created_by` integer,
	`created_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_type" CHECK(type IN ('playlist', 'live', 'stinger'))
);
--> statement-breakpoint
CREATE INDEX `events_station_start_at` ON `events` (`station_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `generator_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`run_type` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`mode` text,
	`hours_json` text,
	`status` text NOT NULL,
	`warnings_json` text,
	`error` text,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `generator_runs_station_started_at` ON `generator_runs` (`station_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `hourly_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`plan_date` text NOT NULL,
	`hour` integer NOT NULL,
	`status` text NOT NULL,
	`generated_at` text,
	`total_seconds` real,
	`warnings_json` text,
	`snapshot_json` text,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hourly_plans_status" CHECK(status IN ('draft', 'ready', 'on_air', 'done', 'failed')),
	CONSTRAINT "hourly_plans_hour" CHECK(hour >= 0 AND hour <= 23)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_hourly_plans_plan` ON `hourly_plans` (`station_id`,`plan_date`,`hour`);--> statement-breakpoint
CREATE TABLE `listener_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`ts` text NOT NULL,
	`mount` text NOT NULL,
	`listeners` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `listener_stats_station_ts_mount` ON `listener_stats` (`station_id`,`ts`,`mount`);--> statement-breakpoint
CREATE TABLE `live_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`user_id` integer,
	`mode` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration` real,
	`recorded_path` text,
	`recorded_size` integer,
	`peak_listeners` integer,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "live_sessions_mode" CHECK(mode IN ('duck', 'takeover'))
);
--> statement-breakpoint
CREATE INDEX `live_sessions_station_started_at` ON `live_sessions` (`station_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`path` text NOT NULL,
	`relative_path` text,
	`title` text,
	`artist` text,
	`artist_sort` text,
	`album` text,
	`album_artist` text,
	`genre` text,
	`year` integer,
	`duration` real,
	`sample_rate` integer,
	`channels` integer,
	`bitrate` integer,
	`codec` text,
	`loudness_lufs` real,
	`peak_db` real,
	`gain_db` real,
	`cue_in` real,
	`cue_out` real,
	`fade_in` real,
	`fade_out` real,
	`artwork_path` text,
	`hash` text,
	`size` integer,
	`mtime` text,
	`status` text NOT NULL,
	`tags_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "media_status" CHECK(status IN ('ok', 'missing', 'processing', 'error', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_media_path` ON `media` (`path`);--> statement-breakpoint
CREATE INDEX `media_station_artist` ON `media` (`station_id`,`artist`);--> statement-breakpoint
CREATE INDEX `media_station_title` ON `media` (`station_id`,`title`);--> statement-breakpoint
CREATE TABLE `metadata_suggestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_id` integer NOT NULL,
	`source` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_password_resets_token_hash` ON `password_resets` (`token_hash`);--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` integer NOT NULL,
	`position` integer NOT NULL,
	`media_id` integer,
	`kind` text NOT NULL,
	`start_seconds` real DEFAULT 0 NOT NULL,
	`length` real DEFAULT 0 NOT NULL,
	`playlist_id` integer,
	`artist` text,
	`title` text,
	`is_locked` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `hourly_plans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "plan_items_kind" CHECK(kind IN ('music', 'news', 'jingle', 'live'))
);
--> statement-breakpoint
CREATE INDEX `plan_items_plan_position` ON `plan_items` (`plan_id`,`position`);--> statement-breakpoint
CREATE TABLE `play_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`media_id` integer NOT NULL,
	`plan_id` integer,
	`started_at` text NOT NULL,
	`ended_at` text,
	`source` text NOT NULL,
	`listeners_peak` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `hourly_plans`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "play_history_source" CHECK(source IN ('automation', 'live', 'event', 'request', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `play_history_station_started_at` ON `play_history` (`station_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `playlist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`playlist_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `playlist_items_playlist_position` ON `playlist_items` (`playlist_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_playlist_items_media` ON `playlist_items` (`playlist_id`,`media_id`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`prefix` text,
	`rotation` text,
	`weight` real DEFAULT 1 NOT NULL,
	`is_jingle` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "playlists_role" CHECK(role IN ('music', 'news', 'jingle', 'general', 'decade'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_playlists_name` ON `playlists` (`name`);--> statement-breakpoint
CREATE TABLE `request_blacklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`pattern` text NOT NULL,
	`match_type` text NOT NULL,
	`created_by` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `request_blacklist_pattern` ON `request_blacklist` (`pattern`);--> statement-breakpoint
CREATE TABLE `request_rate_limits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`ip` text NOT NULL,
	`window_start` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_request_rate_limits_window` ON `request_rate_limits` (`station_id`,`ip`,`window_start`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`listener_ip` text NOT NULL,
	`display_name` text,
	`contact` text,
	`artist` text,
	`title` text,
	`message` text,
	`dedication` text,
	`media_id` integer,
	`status` text NOT NULL,
	`moderated_by` integer,
	`moderated_at` text,
	`play_after` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`played_at` text,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`moderated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requests_status" CHECK(status IN ('pending', 'approved', 'rejected', 'played', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `requests_station_status_created_at` ON `requests` (`station_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `schedule_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_schedule_settings_key` ON `schedule_settings` (`station_id`,`key`);--> statement-breakpoint
CREATE TABLE `schedule_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`hour` integer NOT NULL,
	`playlist_id` integer NOT NULL,
	`start_time` text,
	`end_time` text,
	`days_json` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`loop_once` integer DEFAULT 0 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "schedule_slots_hour" CHECK(hour >= 0 AND hour <= 23)
);
--> statement-breakpoint
CREATE INDEX `schedule_slots_station_hour` ON `schedule_slots` (`station_id`,`hour`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_schedule_slots_slot` ON `schedule_slots` (`station_id`,`hour`,`start_date`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`ip` text NOT NULL,
	`user_agent` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sessions_token_hash` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_expires_at` ON `sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_settings_key` ON `settings` (`key`);--> statement-breakpoint
CREATE TABLE `stations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`timezone` text NOT NULL,
	`locale` text NOT NULL,
	`logo_url` text,
	`colors_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`station_id` integer DEFAULT 1 NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 0 NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_role" CHECK(role IN ('admin', 'dj', 'operator'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_users_email` ON `users` (`email`);