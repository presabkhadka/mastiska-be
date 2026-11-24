import { Injectable } from '@nestjs/common';

/**
 * HAND-CODE (plan.md §2A "canonical URLs, duplicate saves", §2C "unique
 * constraints for canonical resource identity").
 *
 * Placeholder only: returns the input unchanged so CRUD works end to end.
 * Decide and implement:
 *  - Normalization rules (scheme/host case, default ports, trailing slash,
 *    fragment, tracking params like utm_*, www., redirect-resolved URL vs
 *    <link rel=canonical> discovered during ingestion).
 *  - What a duplicate save means (reject? return existing? bump?) and the DB
 *    constraint that guarantees it under concurrent requests.
 */
@Injectable()
export class BookmarkIdentityService {
  canonicalize = (url: string): string => {
    const u = new URL(url);

    if (u.hostname.startsWith('www.')) u.hostname = u.hostname.slice(4);

    for (const key of [...u.searchParams.keys()]) {
      u.searchParams.delete(key);
    }

    u.searchParams.sort();
    u.hash = '';
    return u.toString();
  };
}
