import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_ID_LENGTH, isUploadIdShape } from '../src/lib/storage/upload-id';

describe('the shape of an upload id', () => {
  it('takes printable ASCII up to the longest id a store hands out', () => {
    expect(isUploadIdShape('up_1')).toBe(true);
    expect(isUploadIdShape('v1.eyJ1IjoiYSJ9.sig-_')).toBe(true);
    expect(isUploadIdShape('a'.repeat(MAX_UPLOAD_ID_LENGTH))).toBe(true);
  });

  it.each([
    ['one character past the longest id', 'a'.repeat(MAX_UPLOAD_ID_LENGTH + 1)],
    ['an empty string', ''],
    ['a space', 'up 1'],
    ['a line break', 'up\n1'],
    ['a character past ASCII', 'up_é'],
    ['a number', 12],
    ['nothing', undefined],
  ])('refuses %s', (_label, value) => {
    expect(isUploadIdShape(value)).toBe(false);
  });
});
