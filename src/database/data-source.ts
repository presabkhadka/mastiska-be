import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * Shared TypeORM options for the Nest app and the migration CLI.
 * Schema changes go through migrations only (synchronize is off).
 */
export const dataSourceOptions = (
  url = process.env.DATABASE_URL,
): DataSourceOptions => ({
  type: 'postgres',
  url,
  entities: [__dirname + '/../**/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  migrationsRun: false,
});

export default new DataSource(dataSourceOptions());
