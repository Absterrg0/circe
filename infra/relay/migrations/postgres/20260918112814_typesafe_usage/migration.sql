CREATE TABLE "relay_type_safe_decisions" (
	"decision_id" varchar(191) PRIMARY KEY,
	"environment_id" varchar(191) NOT NULL,
	"started_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_type_safe_decisions_environment" ON "relay_type_safe_decisions" ("environment_id","started_at");