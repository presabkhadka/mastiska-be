import { MigrationInterface, QueryRunner } from "typeorm";

export class ContentRefresh1795546706069 implements MigrationInterface {
    name = 'ContentRefresh1795546706069'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bookmarks" ADD "auto_refresh" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "content_hash" character(64)`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "etag" text`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "last_modified" text`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "checked_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "next_check_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "refresh_interval_hours" integer NOT NULL DEFAULT '12'`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "refresh_failures" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "last_refresh_error" text`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" ADD "content_changed_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "idx_bookmark_contents_next_check" ON "bookmark_contents"  ("next_check_at") `);
        // Same hash as the app (sha256 hex of text_content), so the first refresh can tell "unchanged".
        await queryRunner.query(`
            UPDATE "bookmark_contents"
            SET "content_hash" = encode(sha256(convert_to("text_content", 'UTF8')), 'hex'),
                "checked_at" = "extracted_at",
                "next_check_at" = "extracted_at" + interval '12 hours'
            WHERE "text_content" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_bookmark_contents_next_check"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "content_changed_at"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "last_refresh_error"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "refresh_failures"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "refresh_interval_hours"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "next_check_at"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "checked_at"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "last_modified"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "etag"`);
        await queryRunner.query(`ALTER TABLE "bookmark_contents" DROP COLUMN "content_hash"`);
        await queryRunner.query(`ALTER TABLE "bookmarks" DROP COLUMN "auto_refresh"`);
    }

}
