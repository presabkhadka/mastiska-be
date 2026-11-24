import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgCode(err: unknown): string | undefined {
  return err instanceof QueryFailedError
    ? (err.driverError as { code?: string } | undefined)?.code
    : undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === PG_UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === PG_FOREIGN_KEY_VIOLATION;
}
