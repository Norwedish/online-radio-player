ALTER TABLE `media` ADD `autocue_json` text;--> statement-breakpoint
ALTER TABLE `media` ADD `loudness_envelope` text;--> statement-breakpoint
ALTER TABLE `media` ADD `cue_source` text DEFAULT 'auto';