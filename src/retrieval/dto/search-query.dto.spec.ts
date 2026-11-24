import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SearchQueryDto } from './search-query.dto';

const check = (raw: Record<string, unknown>) => {
  const dto = plainToInstance(SearchQueryDto, raw);
  return { dto, errors: validateSync(dto).map((e) => e.property) };
};

describe('SearchQueryDto', () => {
  it('applies defaults and coerces query-string numbers', () => {
    const { dto, errors } = check({ q: '  turnstile  ', limit: '5' });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({ q: 'turnstile', mode: 'hybrid', limit: 5 });
  });

  it.each([
    [{ q: '' }, 'q'],
    [{ q: '   ' }, 'q'],
    [{ q: 'x'.repeat(501) }, 'q'],
    [{ q: 'x', mode: 'fuzzy' }, 'mode'],
    [{ q: 'x', limit: '0' }, 'limit'],
    [{ q: 'x', limit: '51' }, 'limit'],
    [{ q: 'x', collectionId: 'nope' }, 'collectionId'],
    [{ q: 'x', domain: "x.org' OR 1=1" }, 'domain'],
    [{ q: 'x', domain: 'localhost' }, 'domain'],
    [{ q: 'x', savedAfter: 'yesterday' }, 'savedAfter'],
  ])('rejects %j', (raw, field) => {
    expect(check(raw).errors).toContain(field);
  });

  it('lowercases the domain', () => {
    expect(check({ q: 'x', domain: 'En.Wikipedia.ORG' }).dto.domain).toBe(
      'en.wikipedia.org',
    );
  });
});
