import { MigrationInterface, QueryRunner } from 'typeorm';

export class BookmarkContents1795514451532 implements MigrationInterface {
  name = 'BookmarkContents1795514451532';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "bookmark_contents" ("bookmark_id" uuid NOT NULL, "final_url" text NOT NULL, "http_status" smallint NOT NULL, "content_type" character varying(255) NOT NULL, "raw_html" text NOT NULL, "fetched_at" TIMESTAMP WITH TIME ZONE NOT NULL, "title" character varying(500), "byline" text, "site_name" text, "lang" character varying(35), "excerpt" text, "published_time" text, "source_canonical_url" text, "content_html" text, "text_content" text, "word_count" integer, "extracted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_f4d0711d1db286a22a6dff5cef9" PRIMARY KEY ("bookmark_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "bookmark_contents" ADD CONSTRAINT "FK_f4d0711d1db286a22a6dff5cef9" FOREIGN KEY ("bookmark_id") REFERENCES "bookmarks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bookmark_contents" DROP CONSTRAINT "FK_f4d0711d1db286a22a6dff5cef9"`,
    );
    await queryRunner.query(`DROP TABLE "bookmark_contents"`);
  }
}
