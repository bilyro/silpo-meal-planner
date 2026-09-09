ALTER TABLE "oauth_tokens" ADD COLUMN "confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "confirm_code" text;