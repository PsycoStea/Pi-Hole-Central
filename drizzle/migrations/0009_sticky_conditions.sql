-- Persistent ("sticky") condition notifications.
--
-- Alerts split into two kinds: EVENTS, which happened at a point in time
-- (offline, recovery), and CONDITIONS, which are true for a while (nodes out of
-- sync, blocking disabled, disk filling, cert expiring, latency high).
--
-- Events get a row each. Conditions now get exactly ONE live row that is updated
-- in place while the condition holds and marked resolved when it clears, so an
-- ongoing problem is a standing indicator rather than a stream of repeat pings.
--
-- The live row is also what makes this restart-safe: condition state lives in
-- the database, not in an in-memory map, so redeploying no longer re-announces
-- a condition that was already raised.
ALTER TABLE `notifications` ADD `sticky` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `notifications` ADD `raised_at` integer;
--> statement-breakpoint
ALTER TABLE `notifications` ADD `resolved_at` integer;
--> statement-breakpoint
-- Lookup path for "is there a live row for this (type, instance)?", run on every
-- condition evaluation.
CREATE INDEX `idx_notifications_live` ON `notifications` (`sticky`,`resolved_at`,`type`,`instance_id`);
