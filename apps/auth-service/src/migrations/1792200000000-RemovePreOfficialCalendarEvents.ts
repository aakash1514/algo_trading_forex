import { MigrationInterface, QueryRunner } from 'typeorm';

// Roadmap step 6a. Deletes the economic events stored before the official calendars (the rows without a
// source: all of them came from the third-party weekly calendar feed that step 6a removed, whose terms
// were never confirmed), logging the counts before and after, then makes the source required. Every
// event now names the official calendar it comes from. down() makes source optional again; the deleted
// rows are not restored (they were a third party's data).
export class RemovePreOfficialCalendarEvents1792200000000 implements MigrationInterface {
  name = 'RemovePreOfficialCalendarEvents1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const count = async (where: string) =>
      Number((await queryRunner.query(`SELECT count(*)::int AS n FROM economic_events WHERE ${where}`))[0].n);
    const before = await count('source IS NULL');
    const kept = await count('source IS NOT NULL');
    await queryRunner.query(`DELETE FROM economic_events WHERE source IS NULL`);
    const after = await count('source IS NULL');
    if (after !== 0 || (await count('source IS NOT NULL')) !== kept) {
      throw new Error(`economic_events cleanup left ${after} row(s) without a source`);
    }
    console.log(`RemovePreOfficialCalendarEvents: rows without a source ${before} -> ${after}; official events kept: ${kept}`);
    await queryRunner.query(`ALTER TABLE economic_events ALTER COLUMN source SET NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE economic_events ALTER COLUMN source DROP NOT NULL`);
  }
}
