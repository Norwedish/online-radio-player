CREATE TABLE `device_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`platform` text,
	`app_version` text,
	`access_hash` text,
	`access_expires_at` text,
	`refresh_hash` text,
	`prev_refresh_hash` text,
	`refresh_expires_at` text,
	`pairing_hash` text,
	`pairing_expires_at` text,
	`created_ip` text,
	`last_ip` text,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_device_grants_access_hash` ON `device_grants` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_device_grants_refresh_hash` ON `device_grants` (`refresh_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_device_grants_pairing_hash` ON `device_grants` (`pairing_hash`);--> statement-breakpoint
CREATE INDEX `device_grants_user` ON `device_grants` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `device_grants_prev_refresh` ON `device_grants` (`prev_refresh_hash`);