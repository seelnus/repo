import { normalizeEvalTemplate } from './eval.types';

function template(instructions?: unknown) {
  return {
    version: 2,
    kind: 'evaluation',
    instructions,
    dimensions: [],
    questions: [],
  };
}

describe('normalizeEvalTemplate instructions', () => {
  it('keeps internal line breaks and trims surrounding whitespace', () => {
    expect(
      normalizeEvalTemplate(template('  第一行\n第二行  ')).instructions,
    ).toBe('第一行\n第二行');
  });

  it('normalizes missing and non-string instructions to an empty string', () => {
    expect(normalizeEvalTemplate(template()).instructions).toBe('');
    expect(
      normalizeEvalTemplate(template({ text: 'invalid' })).instructions,
    ).toBe('');
  });

  it('rejects instructions longer than 2000 characters', () => {
    expect(() => normalizeEvalTemplate(template('说'.repeat(2001)))).toThrow(
      '填写说明不能超过 2000 字',
    );
  });
});
