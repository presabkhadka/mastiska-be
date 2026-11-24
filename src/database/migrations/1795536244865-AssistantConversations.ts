import { MigrationInterface, QueryRunner } from "typeorm";

export class AssistantConversations1795536244865 implements MigrationInterface {
    name = 'AssistantConversations1795536244865'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "conversations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "title" character varying(200), CONSTRAINT "PK_ee34f4f7ced4ec8681f26bf04ef" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_conversations_user_updated" ON "conversations"  ("user_id", "updated_at") `);
        await queryRunner.query(`CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'awaiting_approval', 'completed', 'failed', 'limit_exceeded')`);
        await queryRunner.query(`CREATE TABLE "agent_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "conversation_id" uuid NOT NULL, "user_message_id" uuid NOT NULL, "status" "public"."agent_run_status" NOT NULL DEFAULT 'running', "model" character varying(100), "steps" integer NOT NULL DEFAULT '0', "tool_call_count" integer NOT NULL DEFAULT '0', "tokens_used" integer NOT NULL DEFAULT '0', "contents" jsonb NOT NULL DEFAULT '[]', "error" text, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_442f7e0ec4ae860cf17edc57825" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_agent_runs_active_per_conversation" ON "agent_runs"  ("conversation_id") WHERE "status" IN ('running', 'awaiting_approval')`);
        await queryRunner.query(`CREATE TABLE "conversation_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "conversation_id" uuid NOT NULL, "role" character varying(16) NOT NULL, "content" text NOT NULL, "run_id" uuid, "client_message_id" character varying(100), CONSTRAINT "PK_113248f25c4c0a7c179b3f5a609" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_conversation_messages_client_id" ON "conversation_messages"  ("conversation_id", "client_message_id") WHERE "client_message_id" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "idx_conversation_messages_conv_created" ON "conversation_messages"  ("conversation_id", "created_at") `);
        await queryRunner.query(`CREATE TYPE "public"."tool_call_status" AS ENUM('invalid', 'awaiting_approval', 'rejected', 'running', 'succeeded', 'failed')`);
        await queryRunner.query(`CREATE TABLE "tool_calls" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "run_id" uuid NOT NULL, "conversation_id" uuid NOT NULL, "step" integer NOT NULL, "model_call_id" character varying(200), "name" character varying(100) NOT NULL, "args" jsonb NOT NULL, "status" "public"."tool_call_status" NOT NULL, "requires_approval" boolean NOT NULL DEFAULT false, "result" jsonb, "error" text, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_08984f8a6bc13859241462df855" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_tool_calls_run_created" ON "tool_calls"  ("run_id", "created_at") `);
        await queryRunner.query(`ALTER TABLE "conversations" ADD CONSTRAINT "FK_3a9ae579e61e81cc0e989afeb4a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "agent_runs" ADD CONSTRAINT "FK_3bf7cd6e8aa46c1c6008bf7d0d3" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD CONSTRAINT "FK_8e166abf2dd2ee28670e53e6803" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tool_calls" ADD CONSTRAINT "FK_fb18eec0a2a2aa4f4dd3a716a6d" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tool_calls" DROP CONSTRAINT "FK_fb18eec0a2a2aa4f4dd3a716a6d"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP CONSTRAINT "FK_8e166abf2dd2ee28670e53e6803"`);
        await queryRunner.query(`ALTER TABLE "agent_runs" DROP CONSTRAINT "FK_3bf7cd6e8aa46c1c6008bf7d0d3"`);
        await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT "FK_3a9ae579e61e81cc0e989afeb4a"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tool_calls_run_created"`);
        await queryRunner.query(`DROP TABLE "tool_calls"`);
        await queryRunner.query(`DROP TYPE "public"."tool_call_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_conversation_messages_conv_created"`);
        await queryRunner.query(`DROP INDEX "public"."uq_conversation_messages_client_id"`);
        await queryRunner.query(`DROP TABLE "conversation_messages"`);
        await queryRunner.query(`DROP INDEX "public"."uq_agent_runs_active_per_conversation"`);
        await queryRunner.query(`DROP TABLE "agent_runs"`);
        await queryRunner.query(`DROP TYPE "public"."agent_run_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_conversations_user_updated"`);
        await queryRunner.query(`DROP TABLE "conversations"`);
    }

}
