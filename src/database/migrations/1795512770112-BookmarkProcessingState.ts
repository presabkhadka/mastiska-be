import { MigrationInterface, QueryRunner } from "typeorm";

export class BookmarkProcessingState1795512770112 implements MigrationInterface {
    name = 'BookmarkProcessingState1795512770112'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."bookmark_processing_state" AS ENUM('pending', 'fetching', 'fetched', 'extracting', 'ready', 'failed', 'unsupported')`);
        await queryRunner.query(`ALTER TABLE "bookmarks" ADD "processing_state" "public"."bookmark_processing_state" NOT NULL DEFAULT 'pending'`);
        await queryRunner.query(`ALTER TABLE "bookmarks" ADD "processing_error" text`);
        await queryRunner.query(`ALTER TABLE "bookmarks" ADD "processing_state_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`CREATE INDEX "idx_bookmarks_processing_state_changed" ON "bookmarks"  ("processing_state", "processing_state_changed_at") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_bookmarks_processing_state_changed"`);
        await queryRunner.query(`ALTER TABLE "bookmarks" DROP COLUMN "processing_state_changed_at"`);
        await queryRunner.query(`ALTER TABLE "bookmarks" DROP COLUMN "processing_error"`);
        await queryRunner.query(`ALTER TABLE "bookmarks" DROP COLUMN "processing_state"`);
        await queryRunner.query(`DROP TYPE "public"."bookmark_processing_state"`);
    }

}
