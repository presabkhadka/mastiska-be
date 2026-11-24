import { MigrationInterface, QueryRunner } from "typeorm";

export class OwnershipAndVersions1795543809258 implements MigrationInterface {
    name = 'OwnershipAndVersions1795543809258'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notes" ADD "version" integer NOT NULL DEFAULT '1'`);
        await queryRunner.query(`ALTER TABLE "collections" ADD CONSTRAINT "uq_collections_id_user" UNIQUE ("id", "user_id")`);
        await queryRunner.query(`ALTER TABLE "tags" ADD CONSTRAINT "uq_tags_id_user" UNIQUE ("id", "user_id")`);
        await queryRunner.query(`ALTER TABLE "bookmarks" ADD CONSTRAINT "uq_bookmarks_id_user" UNIQUE ("id", "user_id")`);

        // Collection names: unique per user, case-insensitive. Existing duplicates get " (2)", " (3)"...
        await queryRunner.query(`
            UPDATE "collections" c SET "name" = left(c."name", 95) || ' (' || d.rn || ')'
            FROM (
                SELECT "id", row_number() OVER (PARTITION BY "user_id", lower("name") ORDER BY "created_at", "id") AS rn
                FROM "collections"
            ) d
            WHERE d."id" = c."id" AND d.rn > 1`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_collections_user_lower_name" ON "collections" ("user_id", lower("name"))`);

        // Links carry the owner so composite FKs can require bookmark and tag/collection to share it.
        for (const [table, col, parent] of [
            ['bookmark_tags', 'tag_id', 'tags'],
            ['bookmark_collections', 'collection_id', 'collections'],
        ]) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD "user_id" uuid`);
            await queryRunner.query(`UPDATE "${table}" l SET "user_id" = b."user_id" FROM "bookmarks" b WHERE b."id" = l."bookmark_id"`);
            await queryRunner.query(`DELETE FROM "${table}" l USING "${parent}" p WHERE p."id" = l."${col}" AND p."user_id" <> l."user_id"`);
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "user_id" SET NOT NULL`);
        }
        await queryRunner.query(`ALTER TABLE "bookmark_tags" DROP CONSTRAINT "FK_fab2760408a0e460cacc6cbdacc"`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" DROP CONSTRAINT "FK_6dbf982610ba36aeb391e1fead5"`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" DROP CONSTRAINT "FK_a4102c96729238ec453e2022a0f"`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" DROP CONSTRAINT "FK_6314fed467f5b8e49d91ac3e06c"`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" ADD CONSTRAINT "fk_bookmark_tags_bookmark_owner" FOREIGN KEY ("bookmark_id", "user_id") REFERENCES "bookmarks"("id", "user_id") ON DELETE CASCADE`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" ADD CONSTRAINT "fk_bookmark_tags_tag_owner" FOREIGN KEY ("tag_id", "user_id") REFERENCES "tags"("id", "user_id") ON DELETE CASCADE`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" ADD CONSTRAINT "fk_bookmark_collections_bookmark_owner" FOREIGN KEY ("bookmark_id", "user_id") REFERENCES "bookmarks"("id", "user_id") ON DELETE CASCADE`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" ADD CONSTRAINT "fk_bookmark_collections_collection_owner" FOREIGN KEY ("collection_id", "user_id") REFERENCES "collections"("id", "user_id") ON DELETE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bookmark_collections" DROP CONSTRAINT "fk_bookmark_collections_collection_owner"`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" DROP CONSTRAINT "fk_bookmark_collections_bookmark_owner"`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" DROP CONSTRAINT "fk_bookmark_tags_tag_owner"`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" DROP CONSTRAINT "fk_bookmark_tags_bookmark_owner"`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" ADD CONSTRAINT "FK_6314fed467f5b8e49d91ac3e06c" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" ADD CONSTRAINT "FK_a4102c96729238ec453e2022a0f" FOREIGN KEY ("bookmark_id") REFERENCES "bookmarks"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" ADD CONSTRAINT "FK_6dbf982610ba36aeb391e1fead5" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" ADD CONSTRAINT "FK_fab2760408a0e460cacc6cbdacc" FOREIGN KEY ("bookmark_id") REFERENCES "bookmarks"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "bookmark_collections" DROP COLUMN "user_id"`);
        await queryRunner.query(`ALTER TABLE "bookmark_tags" DROP COLUMN "user_id"`);
        await queryRunner.query(`DROP INDEX "public"."uq_collections_user_lower_name"`);
        await queryRunner.query(`ALTER TABLE "bookmarks" DROP CONSTRAINT "uq_bookmarks_id_user"`);
        await queryRunner.query(`ALTER TABLE "tags" DROP CONSTRAINT "uq_tags_id_user"`);
        await queryRunner.query(`ALTER TABLE "collections" DROP CONSTRAINT "uq_collections_id_user"`);
        await queryRunner.query(`ALTER TABLE "notes" DROP COLUMN "version"`);
    }

}
