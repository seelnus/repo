import { EvalAnswer, EvalResponseForScoring, EvalTemplate } from './eval.types';

export type EvalQuestionScore = {
  questionId: string;
  label: string;
  dimensionId: string;
  score: number | null;
  selfScore: number | null;
  otherScore: number | null;
  answerCount: number;
};

export type EvalScoreResult = {
  totalScore: number | null;
  questionScores: EvalQuestionScore[];
  dimensionScores: Array<{
    dimensionId: string;
    name: string;
    score: number | null;
  }>;
};

function average(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function answerScore(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const score = Number((value as EvalAnswer).score);
  return Number.isInteger(score) && score >= 0 && score <= 5 ? score : null;
}

export function calculateEmployeeScore(
  template: EvalTemplate,
  responses: EvalResponseForScoring[],
): EvalScoreResult {
  const questionScores = template.questions
    .filter((question) => question.countInScore)
    .map((question) => {
      const all: number[] = [];
      const self: number[] = [];
      const other: number[] = [];
      for (const response of responses) {
        const score = answerScore(response.answers[question.id]);
        if (score === null) continue;
        all.push(score);
        if (response.relationType === 'self') self.push(score);
        else other.push(score);
      }
      return {
        questionId: question.id,
        label: question.label,
        dimensionId: question.dimensionId,
        score: average(all),
        selfScore: average(self),
        otherScore: average(other),
        answerCount: all.length,
      };
    });

  const dimensionScores = template.dimensions.map((dimension) => ({
    dimensionId: dimension.id,
    name: dimension.name,
    score: average(
      questionScores
        .filter(
          (question) =>
            question.dimensionId === dimension.id && question.score !== null,
        )
        .map((question) => question.score as number),
    ),
  }));
  const totalScore = average(
    questionScores
      .filter((question) => question.score !== null)
      .map((question) => question.score as number),
  );
  return { totalScore, questionScores, dimensionScores };
}
