import { calculateEmployeeScore } from './eval-scoring';
import { buildAutoRelations } from './eval.service';
import { EvalTemplate } from './eval.types';

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
