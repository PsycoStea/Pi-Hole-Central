-- Node operation lock + persisted recovery budget (audit P5.2 R2-NV3, P5.4 R2-F8).
--
-- node_locks: at most one operation per Pi-hole node at a time (update, gravity,
-- Teleporter export, SSH recovery, watchdog restart). Rows carry their own expiry,
-- so a holder that crashed releases the node by itself.
--
-- recovery_state: the restart/reboot budget and the "manual intervention
-- required" latch used to live only in process memory, so every app restart
-- re-armed a full restart x3 + reboot lap on a node already judged unrecoverable.
--
-- Additive only: code from before this migration ignores both tables, so a
-- rollback is a revert + redeploy with no DB restore.
CREATE TABLE `node_locks` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`token` text NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recovery_state` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`state_json` text,
	`last_reboot_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade
);
