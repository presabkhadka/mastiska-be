import { Injectable } from '@nestjs/common';

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
