ALTER TABLE "expenses" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_request_key_unique" UNIQUE("request_key");