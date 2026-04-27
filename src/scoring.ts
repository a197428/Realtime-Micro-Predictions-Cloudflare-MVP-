import type { Annotation, PredictionEvent } from './types';

export function calculateScore(
  correct: boolean,
  choice: 'A' | 'B',
  answers: Record<string, 'A' | 'B'>,
  streak: number
): number {
  if (!correct) return -10;

  const total = Object.keys(answers).length || 1;
  const sameChoice = Object.values(answers).filter((a) => a === choice).length;
  const consensus = sameChoice / total;

  // Contrarian scoring: fewer people picked this → more points
  const points = 100 * (1 - consensus) * (1 + 0.1 * streak);
  return Math.round(points);
}

export function resolveWinner(event: PredictionEvent): 'A' | 'B' {
  const answers = Object.values(event.answers);
  if (answers.length === 0) {
    return Math.random() < 0.5 ? 'A' : 'B';
  }

  const countA = answers.filter((a) => a === 'A').length;
  const countB = answers.filter((a) => a === 'B').length;

  if (countA === countB) {
    return Math.random() < 0.5 ? 'A' : 'B';
  }

  return countA > countB ? 'A' : 'B';
}

export async function annotateEvent(event: PredictionEvent): Promise<Annotation> {
  // Simulated AI annotation
  const answers = Object.values(event.answers);
  const countA = answers.filter((a) => a === 'A').length;
  const countB = answers.filter((a) => a === 'B').length;

  const answer: 'A' | 'B' = countA >= countB ? 'A' : 'B';
  const confidence = 0.65 + Math.random() * 0.3;

  const reasons = [
    `${answer === 'A' ? event.teamA : event.teamB} has shown stronger performance recently.`,
    `Statistical analysis favors ${answer === 'A' ? event.teamA : event.teamB} in this situation.`,
    `Historical data suggests ${answer === 'A' ? event.teamA : event.teamB} tends to dominate here.`,
    `Current match momentum is with ${answer === 'A' ? event.teamA : event.teamB}.`,
  ];

  return {
    source: 'ai',
    answer,
    confidence: Math.round(confidence * 100) / 100,
    reason: reasons[Math.floor(Math.random() * reasons.length)],
  };
}
