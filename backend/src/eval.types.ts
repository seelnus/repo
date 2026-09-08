export const EVAL_CYCLE_STATUSES = [
  'draft',
  'published',
  'closed',
  'locked',
  'archived',
] as const;
export type EvalCycleStatus = (typeof EVAL_CYCLE_STATUSES)[number];

export const EVAL_PARTICIPANT_MODES = ['normal', 'special'] as const;
export type EvalParticipantMode = (typeof EVAL_PARTICIPANT_MODES)[number];

export type EvalDimension = {
  id: string;
  name: string;
  order: number;
};

export type EvalScoreOption = {
  score: number;
  label: string;
};

export type EvalScoreQuestion = {
  id: string;
  type: 'evaluation_score';
  label: string;
  description?: string;
  dimensionId: string;
  required: boolean;
  countInScore: boolean;
  options: EvalScoreOption[];
  casePrompt?: string;
  caseRequiredScores: number[];
};

export type EvalTextQuestion = {
  id: string;
  type: 'evaluation_text';
  label: string;
  description?: string;
  dimensionId: string;
  required: boolean;
  maxLength: 2000;
};

export type EvalQuestion = EvalScoreQuestion | EvalTextQuestion;

export type EvalTemplate = {
  version: 2;
  kind: 'evaluation';
  instructions?: string;
  dimensions: EvalDimension[];
  questions: EvalQuestion[];
};

export type EvalAnswer = {
  score: number;
  caseText?: string;
};

export type EvalResponseForScoring = {
  relationType: 'self' | 'peer' | 'leader';
  answers: Record<string, unknown>;
};

export function isEvalTemplate(value: unknown): value is EvalTemplate {
  if (!value || typeof value !== 'object') return false;
  const template = value as Partial<EvalTemplate>;
  return (
    template.version === 2 &&
    template.kind === 'evaluation' &&
    Array.isArray(template.dimensions) &&
    Array.isArray(template.questions)
  );
}

export function normalizeEvalTemplate(value: unknown): EvalTemplate {
  if (!isEvalTemplate(value)) {
    return {
      version: 2,
      kind: 'evaluation',
      instructions: '',
      dimensions: [],
      questions: [],
    };
  }
  const instructions =
    typeof value.instructions === 'string' ? value.instructions.trim() : '';
  if (instructions.length > 2000) throw new Error('填写说明不能超过 2000 字');
  const dimensions = value.dimensions
    .map((dimension, index) => ({
      id: String(dimension.id || `dimension-${index + 1}`),
      name: String(dimension.name || '').trim(),
      order: Number.isFinite(Number(dimension.order))
        ? Number(dimension.order)
        : index + 1,
    }))
    .filter((dimension) => dimension.name);
  const dimensionIds = new Set(dimensions.map((dimension) => dimension.id));
  const questions = value.questions.map((rawQuestion, index): EvalQuestion => {
    const question = rawQuestion as Partial<EvalQuestion> &
      Record<string, unknown>;
    const common = {
      id: String(question.id || `eval-question-${index + 1}`),
      label: String(question.label || '').trim(),
      description: String(question.description || ''),
      dimensionId: String(question.dimensionId || ''),
      required: question.required !== false,
    };
    if (question.type === 'evaluation_text') {
      return {
        ...common,
        type: 'evaluation_text',
        maxLength: 2000,
      };
    }
    if (question.type !== 'evaluation_score')
      throw new Error(`题目“${common.label || index + 1}”的题型不受支持`);
    const options = Array.isArray(question.options) ? question.options : [];
    const requiredScores = Array.isArray(question.caseRequiredScores)
      ? question.caseRequiredScores
      : [];
    return {
      ...common,
      type: 'evaluation_score',
      countInScore: question.countInScore !== false,
      options: Array.from({ length: 6 }, (_, score) => ({
        score,
        label: String(
          options.find((option) => Number(option.score) === score)?.label || '',
        ).trim(),
      })),
      casePrompt: String(question.casePrompt || '请填写具体案例').trim(),
      caseRequiredScores: Array.from(new Set(requiredScores.map(Number)))
        .filter((score) => Number.isInteger(score) && score >= 0 && score <= 5)
        .sort((a, b) => a - b),
    };
  });
  for (const question of questions) {
    if (!question.label) throw new Error('环评题目标题不能为空');
    if (!dimensionIds.has(question.dimensionId))
      throw new Error(`题目“${question.label}”未关联有效维度`);
    if (
      question.type === 'evaluation_score' &&
      question.options.some((option) => !option.label)
    )
      throw new Error(`题目“${question.label}”必须填写完整的 0–5 分行为描述`);
  }
  return {
    version: 2,
    kind: 'evaluation',
    instructions,
    dimensions,
    questions,
  };
}
