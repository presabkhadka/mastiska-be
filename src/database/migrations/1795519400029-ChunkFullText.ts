import { MigrationInterface, QueryRunner } from "typeorm";

export class ChunkFullText1795519400029 implements MigrationInterface {
    name = 'ChunkFullText1795519400029'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bookmark_chunks" ADD "search_vector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("section", '')), 'A') || setweight(to_tsvector('english', "content"), 'B')) STORED NOT NULL`);
        // current_database()/current_schema() instead of the generator's hard-coded names.
        await queryRunner.query(`INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES (current_database(), current_schema(), $1, $2, $3, $4)`, ["bookmark_chunks","GENERATED_COLUMN","search_vector","setweight(to_tsvector('english', coalesce(\"section\", '')), 'A') || setweight(to_tsvector('english', \"content\"), 'B')"]);
        await queryRunner.query(`CREATE INDEX "idx_bookmark_chunks_search" ON "bookmark_chunks" USING gin ("search_vector")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_bookmark_chunks_search"`);
        await queryRunner.query(`DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "database" = current_database() AND "schema" = current_schema() AND "table" = $3`, ["GENERATED_COLUMN","search_vector","bookmark_chunks"]);
        await queryRunner.query(`ALTER TABLE "bookmark_chunks" DROP COLUMN "search_vector"`);
    }

}
