export type QuestionType = 'radio' | 'checkbox' | 'rating' | 'description' | 'text' | 'textarea' | 'file' | 'date' | 'datetime';

export type SurveyQuestion = {
  id: string;
  type: QuestionType;
  label: string;
  description?: string;
  required?: boolean;
  options?: string[];
  hasOther?: boolean;
  maxScore?: number;
  maxSizeMB?: number;
  accept?: string[];
  visibleWhen?: {
    questionId: string;
    valueIn: string[];
  };
};

export type SurveySchema = {
  questions: SurveyQuestion[];
  contentHtml?: string;
};

export const emptySurveySchema: SurveySchema = { questions: [], contentHtml: '' };
