import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1795458315470 implements MigrationInterface {
  name = 'InitialSchema1795458315470';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "email" character varying NOT NULL, "password_hash" character varying NOT NULL, "display_name" character varying, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "collections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "name" character varying(100) NOT NULL, "description" text, CONSTRAINT "PK_21c00b1ebbd41ba1354242c5c4e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_collections_user_created" ON "collections"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "notes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "bookmark_id" uuid NOT NULL, "body" text NOT NULL, CONSTRAINT "PK_af6206538ea96c4e77e9f400c3d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notes_bookmark_created" ON "notes"  ("bookmark_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "tags" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "name" character varying(50) NOT NULL, CONSTRAINT "uq_tags_user_name" UNIQUE ("user_id", "name"), CONSTRAINT "PK_e7dc17249a1148a1970748eda99" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "bookmarks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "original_url" text NOT NULL, "canonical_url" text, "title" character varying(500), "is_favorite" boolean NOT NULL DEFAULT false, "is_archived" boolean NOT NULL DEFAULT false, "read_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_7f976ef6cecd37a53bd11685f32" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_bookmarks_user_created" ON "bookmarks"  ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "bookmark_tags" ("bookmark_id" uuid NOT NULL, "tag_id" uuid NOT NULL, CONSTRAINT "PK_2d558ecda3abcfa41b8152f689a" PRIMARY KEY ("bookmark_id", "tag_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fab2760408a0e460cacc6cbdac" ON "bookmark_tags"  ("bookmark_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6dbf982610ba36aeb391e1fead" ON "bookmark_tags"  ("tag_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "bookmark_collections" ("bookmark_id" uuid NOT NULL, "collection_id" uuid NOT NULL, CONSTRAINT "PK_42e162d6485cda6090d8449464e" PRIMARY KEY ("bookmark_id", "collection_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a4102c96729238ec453e2022a0" ON "bookmark_collections"  ("bookmark_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6314fed467f5b8e49d91ac3e06" ON "bookmark_collections"  ("collection_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "collections" ADD CONSTRAINT "FK_728c4a63e823bcd4c687fe46747" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "notes" ADD CONSTRAINT "FK_ced8e290808d4ddf4669fc5c573" FOREIGN KEY ("bookmark_id") REFERENCES "bookmarks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tags" ADD CONSTRAINT "FK_74603743868d1e4f4fc2c0225b6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmarks" ADD CONSTRAINT "FK_58a0fbaee65cd8959a870ee678c" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_tags" ADD CONSTRAINT "FK_fab2760408a0e460cacc6cbdacc" FOREIGN KEY ("bookmark_id") REFERENCES "bookmarks"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_tags" ADD CONSTRAINT "FK_6dbf982610ba36aeb391e1fead5" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_collections" ADD CONSTRAINT "FK_a4102c96729238ec453e2022a0f" FOREIGN KEY ("bookmark_id") REFERENCES "bookmarks"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_collections" ADD CONSTRAINT "FK_6314fed467f5b8e49d91ac3e06c" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookmark_collections" DROP CONSTRAINT "FK_6314fed467f5b8e49d91ac3e06c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_collections" DROP CONSTRAINT "FK_a4102c96729238ec453e2022a0f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_tags" DROP CONSTRAINT "FK_6dbf982610ba36aeb391e1fead5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_tags" DROP CONSTRAINT "FK_fab2760408a0e460cacc6cbdacc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmarks" DROP CONSTRAINT "FK_58a0fbaee65cd8959a870ee678c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tags" DROP CONSTRAINT "FK_74603743868d1e4f4fc2c0225b6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notes" DROP CONSTRAINT "FK_ced8e290808d4ddf4669fc5c573"`,
    );
    await queryRunner.query(
      `ALTER TABLE "collections" DROP CONSTRAINT "FK_728c4a63e823bcd4c687fe46747"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6314fed467f5b8e49d91ac3e06"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a4102c96729238ec453e2022a0"`,
    );
    await queryRunner.query(`DROP TABLE "bookmark_collections"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6dbf982610ba36aeb391e1fead"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fab2760408a0e460cacc6cbdac"`,
    );
    await queryRunner.query(`DROP TABLE "bookmark_tags"`);
    await queryRunner.query(`DROP INDEX "public"."idx_bookmarks_user_created"`);
    await queryRunner.query(`DROP TABLE "bookmarks"`);
    await queryRunner.query(`DROP TABLE "tags"`);
    await queryRunner.query(`DROP INDEX "public"."idx_notes_bookmark_created"`);
    await queryRunner.query(`DROP TABLE "notes"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_collections_user_created"`,
    );
    await queryRunner.query(`DROP TABLE "collections"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
