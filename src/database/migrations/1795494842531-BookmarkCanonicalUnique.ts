import { MigrationInterface, QueryRunner } from "typeorm";

export class BookmarkCanonicalUnique1795494842531 implements MigrationInterface {
    name = 'BookmarkCanonicalUnique1795494842531'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_bookmarks_user_canonical" ON "bookmarks"  ("user_id", "canonical_url") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_bookmarks_user_canonical"`);
    }

}
