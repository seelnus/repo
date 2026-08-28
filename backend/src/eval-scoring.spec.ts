import { calculateEmployeeScore } from './eval-scoring';
import { buildAutoRelations, EvalService } from './eval.service';
import { EvalTemplate, normalizeEvalTemplate } from './eval.types';

const template: EvalTemplate = {
  version: 2,
  kind: 'evaluation',
  dimensions: [
    { id: 'd1', name: '诚信', order: 1 },
    { id: 'd2', name: '团队', order: 2 },
  ],
  questions: [
    {
      id: 'q1',
      type: 'evaluation_score',
      label: '题目1',
      dimensionId: 'd1',
      required: true,
      countInScore: true,
      options: [],
      caseRequiredScores: [],
    },
    {
      id: 'q2',
      type: 'evaluation_score',
      label: '题目2',
      dimensionId: 'd2',
      required: true,
      countInScore: true,
      options: [],
      caseRequiredScores: [],
    },
    {
      id: 'q3',
      type: 'evaluation_score',
      label: '题目3',
      dimensionId: 'd2',
      required: true,
      countInScore: true,
      options: [],
      caseRequiredScores: [],
    },
    {
      id: 'q4',
      type: 'evaluation_score',
      label: '题目4',
      dimensionId: 'd2',
      required: true,
      countInScore: true,
      options: [],
      caseRequiredScores: [],
    },
  ],
};

describe('calculateEmployeeScore', () => {
  it('treats self and peer responses as equally weighted answers', () => {
    const result = calculateEmployeeScore(template, [
      { relationType: 'self', answers: { q1: { score: 5 } } },
      { relationType: 'peer', answers: { q1: { score: 1 } } },
      { relationType: 'peer', answers: { q1: { score: 2 } } },
      { relationType: 'leader', answers: { q1: { score: 4 } } },
    ]);
    expect(result.questionScores[0].score).toBe(3);
  });

  it('averages question scores directly instead of averaging dimensions', () => {
    const result = calculateEmployeeScore(template, [
      {
        relationType: 'self',
        answers: {
          q1: { score: 1 },
          q2: { score: 2 },
          q3: { score: 3 },
          q4: { score: 4 },
        },
      },
    ]);
    expect(result.totalScore).toBe(2.5);
    expect(
      result.dimensionScores.find((item) => item.dimensionId === 'd1')?.score,
    ).toBe(1);
    expect(
      result.dimensionScores.find((item) => item.dimensionId === 'd2')?.score,
    ).toBe(3);
  });

  it('returns null when there are no valid scores', () => {
    const result = calculateEmployeeScore(template, []);
    expect(result.totalScore).toBeNull();
    expect(
      result.questionScores.every((question) => question.score === null),
    ).toBe(true);
  });

  it('excludes text questions from all score calculations', () => {
    const mixedTemplate: EvalTemplate = {
      ...template,
      questions: [
        ...template.questions,
        {
          id: 'text1',
          type: 'evaluation_text',
          label: '文字反馈',
          dimensionId: 'd1',
          required: true,
          maxLength: 2000,
        },
      ],
    };
    const result = calculateEmployeeScore(mixedTemplate, [
      {
        relationType: 'self',
        answers: { q1: { score: 4 }, text1: '需要更多协作' },
      },
    ]);
    expect(result.questionScores).toHaveLength(4);
    expect(
      result.questionScores.some((item) => item.questionId === 'text1'),
    ).toBe(false);
    expect(result.totalScore).toBe(4);
  });

  it('returns no score for a text-only template', () => {
    const textOnlyTemplate: EvalTemplate = {
      version: 2,
      kind: 'evaluation',
      dimensions: [{ id: 'd1', name: '反馈', order: 1 }],
      questions: [
        {
          id: 'text1',
          type: 'evaluation_text',
          label: '改进建议',
          dimensionId: 'd1',
          required: false,
          maxLength: 2000,
        },
      ],
    };
    const result = calculateEmployeeScore(textOnlyTemplate, [
      { relationType: 'peer', answers: { text1: '继续保持' } },
    ]);
    expect(result.questionScores).toEqual([]);
    expect(result.totalScore).toBeNull();
    expect(result.dimensionScores[0].score).toBeNull();
  });
});

describe('buildAutoRelations', () => {
  it('creates N squared relations for a normal group', () => {
    const relations = buildAutoRelations([1, 2, 3], new Set(), 10, 10);
    expect(relations).toHaveLength(9);
    expect(
      relations.filter((relation) => relation.type === 'self'),
    ).toHaveLength(3);
    expect(
      relations.filter((relation) => relation.type === 'peer'),
    ).toHaveLength(6);
  });

  it('keeps special people out of the automatic network', () => {
    const relations = buildAutoRelations([1, 2, 3], new Set([3]), 10, 10);
    expect(relations).toHaveLength(4);
    expect(
      relations.some(
        (relation) => relation.rater === 3 || relation.ratee === 3,
      ),
    ).toBe(false);
  });
});

describe('evaluation text questions', () => {
  const textTemplate: EvalTemplate = {
    version: 2,
    kind: 'evaluation',
    dimensions: [{ id: 'd1', name: '反馈', order: 1 }],
    questions: [
      {
        id: 'text-required',
        type: 'evaluation_text',
        label: '改进建议',
        dimensionId: 'd1',
        required: true,
        maxLength: 2000,
      },
      {
        id: 'text-optional',
        type: 'evaluation_text',
        label: '补充说明',
        dimensionId: 'd1',
        required: false,
        maxLength: 2000,
      },
    ],
  };
  const service = new EvalService({} as never, {} as never) as any;

  it('normalizes text questions without score-only fields', () => {
    const normalized = normalizeEvalTemplate(textTemplate);
    expect(normalized.questions[0]).toEqual({
      id: 'text-required',
      type: 'evaluation_text',
      label: '改进建议',
      description: '',
      dimensionId: 'd1',
      required: true,
      maxLength: 2000,
    });
  });

  it('trims text and drops blank optional answers', () => {
    const answers = service.validateEvalAnswers(textTemplate, {
      'text-required': '  保持沟通  ',
      'text-optional': '  \n ',
    });
    expect(answers).toEqual({ 'text-required': '保持沟通' });
  });

  it('rejects blank required text', () => {
    expect(() =>
      service.validateEvalAnswers(textTemplate, {
        'text-required': ' \n ',
      }),
    ).toThrow('请填写：改进建议');
  });

  it('rejects non-string and overlong text answers', () => {
    expect(() =>
      service.validateEvalAnswers(textTemplate, { 'text-required': 123 }),
    ).toThrow('改进建议 的答案格式不正确');
    expect(() =>
      service.validateEvalAnswers(textTemplate, {
        'text-required': '字'.repeat(2001),
      }),
    ).toThrow('改进建议 最多填写 2000 个字符');
  });

  it('accepts exactly 2000 characters', () => {
    const text = '字'.repeat(2000);
    expect(
      service.validateEvalAnswers(textTemplate, { 'text-required': text }),
    ).toEqual({ 'text-required': text });
  });

  it('rejects answers for questions outside the template snapshot', () => {
    expect(() =>
      service.validateEvalAnswers(textTemplate, {
        'text-required': '正常反馈',
        forged: '非法答案',
      }),
    ).toThrow('答卷包含无效题目：forged');
  });
});
