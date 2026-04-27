import type { PredictionEvent } from './types';

const TEAMS = [
  ['Manchester United', 'Liverpool'],
  ['Real Madrid', 'Barcelona'],
  ['Bayern Munich', 'Borussia Dortmund'],
  ['PSG', 'Marseille'],
  ['Juventus', 'AC Milan'],
  ['Chelsea', 'Arsenal'],
  ['Atletico Madrid', 'Sevilla'],
  ['Inter Milan', 'Napoli'],
];

const PERIODS = ['Q1 - 15:00', 'Q1 - 30:00', 'Q2 - 45:00', 'Q2 - 60:00', 'Q3 - 75:00', 'Q4 - 90:00'];

const QUESTIONS = [
  'Who will score the next goal?',
  'Who will get the next corner kick?',
  'Who will commit the next foul?',
  'Who will get the next yellow card?',
  'Who will win the next throw-in?',
  'Who will make the next substitution?',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateFootballEvent(): PredictionEvent {
  const [teamA, teamB] = randomItem(TEAMS);
  const now = Date.now();

  return {
    id: `event_${now}_${Math.random().toString(36).substr(2, 6)}`,
    matchId: `match_${Math.floor(now / 60000)}`,
    teamA,
    teamB,
    period: randomItem(PERIODS),
    question: randomItem(QUESTIONS),
    optionA: teamA,
    optionB: teamB,
    annotations: [],
    answers: {},
    createdAt: now,
    resolveAt: now + 8000,
    resolved: false,
  };
}
