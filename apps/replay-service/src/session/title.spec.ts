import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateSessionDto } from './dto/create-session.dto';
import { RenameSessionDto } from './dto/rename-session.dto';
import { normalizeTitle, TITLE_MAX_CHARS } from './title';

// Characters written by code point, so nothing invisible sits in this file
const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const EMOJI = ch(0x1f4c8);        // one code point, two UTF-16 units, four UTF-8 bytes
const E_ACUTE = ch(0xe9);         // two UTF-8 bytes

// The same pipe options as replay-service's configure-app.ts
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const errors = async (metatype: ArgumentMetadata['metatype'], value: unknown) => {
  try {
    await pipe.transform(value, { type: 'body', metatype });
    return [];
  } catch (err) {
    if (!(err instanceof BadRequestException)) throw err;
    return (err.getResponse() as { message: string[] }).message;
  }
};

describe('normalizeTitle', () => {
  it('trims, and counts characters (code points), not bytes or UTF-16 units', () => {
    expect(TITLE_MAX_CHARS).toBe(60);
    expect(normalizeTitle('  London open  ')).toEqual({ title: 'London open', error: null });
    expect(normalizeTitle('x'.repeat(60)).title).toBe('x'.repeat(60));
    expect(normalizeTitle(EMOJI.repeat(60)).title).toBe(EMOJI.repeat(60));      // 120 UTF-16 units, 240 bytes
    expect(normalizeTitle(E_ACUTE.repeat(60)).title).toBe(E_ACUTE.repeat(60));  // 120 bytes
    expect(normalizeTitle(` ${'x'.repeat(60)} `).title).toBe('x'.repeat(60));   // the spaces don't count
  });

  it('refuses 61 characters', () => {
    for (const title of ['x'.repeat(61), EMOJI.repeat(61), `${'x'.repeat(60)}${EMOJI}`]) {
      expect(normalizeTitle(title)).toEqual({ title: null, error: 'title must be at most 60 characters' });
    }
  });

  it('empty, blank or null means the auto name', () => {
    for (const raw of [null, undefined, '', '   ']) expect(normalizeTitle(raw)).toEqual({ title: null, error: null });
  });

  it.each([
    ['a newline', ch(0x0a)], ['a tab', ch(0x09)], ['NUL', ch(0x00)], ['DEL', ch(0x7f)], ['a C1 control', ch(0x85)],
    ['a right-to-left override', ch(0x202e)], ['a zero-width space', ch(0x200b)], ['a BOM', ch(0xfeff)],
    ['a line separator', ch(0x2028)], ['a paragraph separator', ch(0x2029)],
  ])('refuses %s anywhere, also at the end (before trimming)', (_name, c) => {
    for (const title of [`ab${c}cd`, `abcd${c}`, `${c}abcd`]) {
      expect(normalizeTitle(title).error).toBe('title must not contain control or invisible formatting characters');
    }
  });

  it('refuses anything but text', () => {
    for (const raw of [42, true, {}, ['a']]) expect(normalizeTitle(raw).error).toBe('title must be text');
  });

  it('keeps markup as plain text (the page renders it as text)', () => {
    expect(normalizeTitle('<img src=x onerror=alert(1)>').title).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('RenameSessionDto and CreateSessionDto through the ValidationPipe', () => {
  it('rename: a title, empty or null; the property is required', async () => {
    for (const title of ['My replay', '', null, 'x'.repeat(60)]) expect(await errors(RenameSessionDto, { title })).toEqual([]);
    expect(await errors(RenameSessionDto, {})).toEqual(['title is required (null clears it)']);
    expect(await errors(RenameSessionDto, { title: 'x'.repeat(61) })).toEqual(['title must be at most 60 characters']);
    expect(await errors(RenameSessionDto, { title: `a${ch(0x202e)}b` }))
      .toEqual(['title must not contain control or invisible formatting characters']);
    expect(await errors(RenameSessionDto, { title: 'ok', other: 1 })).toEqual(['property other should not exist']);
  });

  it('create: the title is optional and follows the same rules', async () => {
    const body = { instrument: 'EUR_USD', startTime: '2022-03-16T09:30Z', timeframe: '1m' };
    expect(await errors(CreateSessionDto, body)).toEqual([]);
    expect(await errors(CreateSessionDto, { ...body, title: 'FOMC week' })).toEqual([]);
    expect(await errors(CreateSessionDto, { ...body, title: 'x'.repeat(61) })).toEqual(['title must be at most 60 characters']);
  });
});
