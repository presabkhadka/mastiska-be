import { MigrationInterface, QueryRunner } from "typeorm";

export class ChunksAndEmbeddings1795515966713 implements MigrationInterface {
    name = 'ChunksAndEmbeddings1795515966713'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
        await queryRunner.query(`CREATE TABLE "bookmark_chunks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bookmark_id" uuid NOT NULL, "position" integer NOT NULL, "section" text, "content" text NOT NULL, "token_estimate" integer NOT NULL, "content_hash" character(64) NOT NULL, "embedding" vector(768), "embedding_model" character varying(100), "embedded_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_04e0296345aeee76ffdeadd3c0b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_bookmark_chunks_position" ON "bookmark_chunks"  ("bookmark_id", "position") `);
        await queryRunner.query(`DROP INDEX "public"."idx_bookmarks_processing_state_changed"`);
        await queryRunner.query(`ALTER TYPE "public"."bookmark_processing_state" ADD VALUE 'extracted'`);
        await queryRunner.query(`ALTER TYPE "public"."bookmark_processing_state" ADD VALUE 'embedding'`);
        await queryRunner.query(`CREATE INDEX "idx_bookmarks_processing_state_changed" ON "bookmarks"  ("processing_state", "processing_state_changed_at") `);
        await queryRunner.query(`ALTER TABLE "bookmark_chunks" ADD CONSTRAINT "FK_9430f1e2ecf8a42a351252ae9ea" FOREIGN KEY ("bookmark_id") REFERENCES "bookmarks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // Vectors are L2-normalized, so cosine distance ranks the same as dot product.
        await queryRunner.query(`CREATE INDEX "idx_bookmark_chunks_embedding" ON "bookmark_chunks" USING hnsw ("embedding" vector_cosine_ops)`);
        // Existing ready rows have no chunks: re-extract them from the stored HTML.
        await queryRunner.query(`UPDATE "bookmarks" SET "processing_state" = 'fetched', "processing_state_changed_at" = now() WHERE "processing_state" = 'ready'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "bookmarks" SET "processing_state" = 'fetched' WHERE "processing_state" IN ('extracted', 'embedding')`);
        await queryRunner.query(`DROP INDEX "public"."idx_bookmark_chunks_embedding"`);
        await queryRunner.query(`ALTER TABLE "bookmark_chunks" DROP CONSTRAINT "FK_9430f1e2ecf8a42a351252ae9ea"`);
        await queryRunner.query(`DROP INDEX "public"."idx_bookmarks_processing_state_changed"`);
        await queryRunner.query(`CREATE TYPE "public"."bookmark_processing_state_old" AS ENUM('pending', 'fetching', 'fetched', 'extracting', 'ready', 'failed', 'unsupported')`);
        await queryRunner.query(`ALTER TABLE "bookmarks" ALTER COLUMN "processing_state" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "bookmarks" ALTER COLUMN "processing_state" TYPE "public"."bookmark_processing_state_old" USING "processing_state"::"text"::"public"."bookmark_processing_state_old"`);
        await queryRunner.query(`DROP TYPE "public"."bookmark_processing_state"`);
        await queryRunner.query(`ALTER TYPE "public"."bookmark_processing_state_old" RENAME TO "bookmark_processing_state"`);
        await queryRunner.query(`ALTER TABLE "bookmarks" ALTER COLUMN "processing_state" SET DEFAULT 'pending'`);
        await queryRunner.query(`CREATE INDEX "idx_bookmarks_processing_state_changed" ON "bookmarks" USING btree ("processing_state", "processing_state_changed_at") `);
        await queryRunner.query(`DROP INDEX "public"."uq_bookmark_chunks_position"`);
        await queryRunner.query(`DROP TABLE "bookmark_chunks"`);
    }

}
