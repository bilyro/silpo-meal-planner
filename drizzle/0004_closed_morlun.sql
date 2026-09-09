CREATE TABLE "shared_recipes" (
	"id" serial PRIMARY KEY NOT NULL,
	"dish_name_key" text NOT NULL,
	"dish_name" text NOT NULL,
	"ingredients_json" jsonb NOT NULL,
	"times_used" integer DEFAULT 1 NOT NULL,
	"contributed_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_recipes_dish_name_key_unique" UNIQUE("dish_name_key")
);
--> statement-breakpoint
ALTER TABLE "shared_recipes" ADD CONSTRAINT "shared_recipes_contributed_by_user_id_users_id_fk" FOREIGN KEY ("contributed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;