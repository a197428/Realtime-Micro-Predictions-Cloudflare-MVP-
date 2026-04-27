export interface PredictionEvent {
  id: string;
  matchId: string;
  teamA: string;
  teamB: string;
  period: string;
  question: string;
  optionA: string;
  optionB: string;
  annotations: Annotation[];
  answers: Record<string, 'A' | 'B'>;
  createdAt: number;
  resolveAt: number;
  resolved: boolean;
  correctAnswer?: string;
}

export interface Annotation {
  source: string;
  answer: 'A' | 'B';
  confidence: number;
  reason: string;
}

export type WebSocketMessage =
  | { type: 'NEW_EVENT'; event: PredictionEvent }
  | { type: 'EVENT_RESOLVED'; eventId: string; winner: string; annotations: Annotation[]; clientResults: Record<string, { correct: boolean; points: number }> }
  | { type: 'LEADERBOARD_UPDATE'; leaderboard: { id: string; score: number; delta: number }[] };
