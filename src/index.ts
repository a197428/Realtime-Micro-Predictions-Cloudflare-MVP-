import { DurableObject } from 'cloudflare:workers';
import { generateFootballEvent } from './eventEngine';
import { annotateEvent, calculateScore, resolveWinner } from './scoring';
import type { PredictionEvent, WebSocketMessage } from './types';

/**
 * Sports Micro-Predictions - MatchRoom Durable Object
 *
 * Real-time prediction game where users predict sports outcomes,
 * earn points based on consensus-weighted scoring with AI annotation.
 */

interface ClientState {
	score: number;
	streak: number;
	lastResult: number | null;
}

export class MatchRoom extends DurableObject<Env> {
  private currentEvent?: PredictionEvent;
  private clientStates: Map<string, ClientState> = new Map();
  private eventLoopTimer?: number;
  private resolveTimer?: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    console.log('MatchRoom constructed', { id: ctx.id.toString() });

    // Initialize SQLite schema
    ctx.blockConcurrencyWhile(async () => {
      await ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, score REAL DEFAULT 0, streak INTEGER DEFAULT 0, last_result INTEGER)`
      );
      await ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, match_id TEXT, team_a TEXT, team_b TEXT, period TEXT, question TEXT, correct_answer TEXT, created_at INTEGER, resolve_at INTEGER, answers_json TEXT, annotations_json TEXT)`
      );
    });

    this.startEventLoop();
  }

	private startEventLoop() {
		console.log('MatchRoom starting event loop');
		this.scheduleNextEvent();
	}

	private clearTimers() {
		if (this.eventLoopTimer) {
			clearTimeout(this.eventLoopTimer);
			this.eventLoopTimer = undefined;
		}
		if (this.resolveTimer) {
			clearTimeout(this.resolveTimer);
			this.resolveTimer = undefined;
		}
	}

	private scheduleNextEvent() {
		this.clearTimers();
		// Задержка 3 секунды перед следующим событием после завершения предыдущего
		this.eventLoopTimer = setTimeout(() => {
			this.generateNewEvent().catch((error) => console.error('generateNewEvent failed', error));
		}, 3000) as unknown as number;
	}

  private async generateNewEvent() {
    this.currentEvent = generateFootballEvent();
    console.log('Generated new event', {
      id: this.currentEvent.id,
      question: this.currentEvent.question,
      resolveAt: this.currentEvent.resolveAt,
    });
    this.broadcastToAll({ type: 'NEW_EVENT', event: this.currentEvent });

    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
    }
    this.resolveTimer = setTimeout(() => {
      console.log('Resolve timer fired for event', this.currentEvent?.id);
      this.resolveCurrentEvent().catch((error) => console.error('resolveCurrentEvent failed', error));
    }, 8000) as unknown as number;

    try {
      await this.ctx.storage.setAlarm(this.currentEvent.resolveAt);
      console.log('Set alarm for event resolution', { eventId: this.currentEvent.id, resolveAt: this.currentEvent.resolveAt });
    } catch (error) {
      console.error('Failed to schedule durable alarm', error);
    }
  }

	private async resolveCurrentEvent() {
		if (!this.currentEvent) {
			console.log('resolveCurrentEvent called but no currentEvent');
			return;
		}

		try {
			const event = this.currentEvent;
			console.log('Resolving event', { id: event.id, answers: event.answers });
			event.resolved = true;

			const annotation = await annotateEvent(event);
			event.annotations.push(annotation);

			const winner = resolveWinner(event);
			event.correctAnswer = winner;

			const clientResults: Record<string, { correct: boolean; points: number }> = {};

			for (const [clientId, choice] of Object.entries(event.answers)) {
				const state = this.getOrCreateClientState(clientId);
				const correct = choice === winner;
				const points = calculateScore(correct, choice, event.answers, state.streak);

				state.score += points;
				if (correct) {
					state.streak++;
				} else {
					state.streak = 0;
				}
				state.lastResult = Date.now();

				await this.saveClientState(clientId, state);

				clientResults[clientId] = { correct, points };
			}

			await this.ctx.storage.sql.exec(`INSERT INTO events (id, match_id, team_a, team_b, period, question, correct_answer, created_at, resolve_at, answers_json, annotations_json) VALUES ('${event.id}', '${event.matchId}', '${event.teamA}', '${event.teamB}', '${event.period}', '${event.question.replace(/'/g, "''")}', '${event.correctAnswer}', ${event.createdAt}, ${event.resolveAt}, '${JSON.stringify(event.answers)}', '${JSON.stringify(event.annotations)}')`);

			this.broadcastToAll({
				type: 'EVENT_RESOLVED',
				eventId: event.id,
				winner,
				annotations: event.annotations,
				clientResults,
			});

			await this.broadcastLeaderboard();
			this.currentEvent = undefined;

			this.scheduleNextEvent();
		} catch (error) {
			console.error('Failed resolving current event', error);
		}
	}

	private getOrCreateClientState(clientId: string): ClientState {
		const existing = this.clientStates.get(clientId);
		if (existing) return existing;
		return { score: 0, streak: 0, lastResult: null };
	}

	private async saveClientState(clientId: string, state: ClientState) {
		await this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO clients (id, score, streak, last_result) VALUES ('${clientId}', ${state.score}, ${state.streak}, ${state.lastResult})`);
		this.clientStates.set(clientId, state);
	}

	private async broadcastLeaderboard() {
		const clients = await this.ctx.storage.sql.exec('SELECT id, score FROM clients ORDER BY score DESC LIMIT 50');
		const clientRows = await clients.toArray();
		console.log('Broadcasting leaderboard rows', clientRows.length);
		const leaderboard = clientRows.map((row) => ({
			id: row.id as string,
			score: (row.score as number) ?? 0,
			delta: 0,
		}));
		this.broadcastToAll({ type: 'LEADERBOARD_UPDATE', leaderboard });
	}

	private broadcastToAll(message: WebSocketMessage) {
		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			console.log('No open websockets to broadcast message', message.type);
			return;
		}
		for (const ws of webSockets) {
			try {
				ws.send(JSON.stringify(message));
			} catch (error) {
				console.error('Failed to send websocket message', error, message.type);
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader === 'websocket') {
			const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
			console.log('Accepting websocket connection');
			this.ctx.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		}
		return new Response('MatchRoom ready');
	}

	async webSocketMessage(ws: WebSocket, msg: string) {
		try {
			const data = JSON.parse(msg);
			console.log('Received websocket message', data);
			if (data.type === 'PREDICT' && this.currentEvent && !this.currentEvent.resolved) {
				const { clientId, choice } = data;
				if (choice === 'A' || choice === 'B') {
					if (!this.currentEvent.answers[clientId]) {
						this.currentEvent.answers[clientId] = choice;
						console.log('Recorded prediction', { eventId: this.currentEvent.id, clientId, choice });
					} else {
						console.log('Prediction ignored: already predicted', { eventId: this.currentEvent.id, clientId });
					}
				}
			}
		} catch (e) {
			console.error('Invalid message', e);
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		console.log('WebSocket closed', code, reason, wasClean);
	}

	async alarm(alarmInfo?: AlarmInvocationInfo) {
		console.log('MatchRoom alarm triggered', { eventId: this.currentEvent?.id, alarmInfo });
		if (this.currentEvent && !this.currentEvent.resolved) {
			await this.resolveCurrentEvent();
		} else {
			console.log('Alarm fired with no active event, scheduling next event');
			this.scheduleNextEvent();
		}
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader === 'websocket') {
			const stub = env.MATCH_ROOM.getByName('room');
			return stub.fetch(request);
		}

		return new Response(INDEX_HTML, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	},
} satisfies ExportedHandler<Env>;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sports Micro-Predictions</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #fff; }
        h1 { text-align: center; color: #e94560; margin-bottom: 20px; }

        .match-card {
            background: linear-gradient(135deg, #16213e 0%, #1a1a2e 100%);
            border: 2px solid #e94560;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
        }
        .match-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .match-id { font-size: 12px; color: #888; }
        .period { background: #e94560; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }

        .teams { display: flex; justify-content: space-around; align-items: center; margin-bottom: 15px; }
        .team { text-align: center; }
        .team-name { font-size: 24px; font-weight: bold; color: #fff; }
        .team-label { font-size: 12px; color: #888; }

        .question { text-align: center; font-size: 18px; margin-bottom: 20px; min-height: 50px; }

        .timer { text-align: center; font-size: 14px; color: #888; margin-bottom: 10px; }
        .timer-bar { height: 4px; background: #333; border-radius: 2px; overflow: hidden; }
        .timer-progress { height: 100%; background: #e94560; transition: width 0.1s linear; }

        .options { display: flex; gap: 15px; justify-content: center; }
        .option-btn {
            flex: 1;
            padding: 20px;
            font-size: 18px;
            font-weight: bold;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .option-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .option-btn.team-a { background: linear-gradient(135deg, #0f3460, #16213e); color: #fff; border: 2px solid #4facfe; }
        .option-btn.team-b { background: linear-gradient(135deg, #4facfe, #0f3460); color: #fff; border: 2px solid #00f2fe; }
        .option-btn:hover:not(:disabled) { transform: translateY(-3px); box-shadow: 0 5px 20px rgba(233,69,96,0.3); }
        .option-btn.selected { border-width: 3px; }

        .status { text-align: center; padding: 10px; border-radius: 8px; margin-bottom: 15px; }
        .status.waiting { background: #333; color: #888; }
        .status.predicted { background: #1e5128; color: #4ade80; }
        .status.resolved { background: #e94560; color: #fff; }

        .result-card {
            background: #16213e;
            border-radius: 10px;
            padding: 15px;
            margin-top: 15px;
            display: none;
        }
        .result-card.show { display: block; }
        .result-winner { font-size: 20px; font-weight: bold; color: #4ade80; margin-bottom: 10px; text-align: center; }
        .result-ai { font-size: 12px; color: #888; text-align: center; margin-bottom: 5px; }
        .result-reason { font-size: 12px; color: #666; text-align: center; font-style: italic; }

        .leaderboard { background: #16213e; border-radius: 12px; padding: 15px; }
        .leaderboard h2 { margin: 0 0 15px 0; color: #e94560; font-size: 18px; }
        .leaderboard-table { width: 100%; border-collapse: collapse; }
        .leaderboard-table th { text-align: left; font-size: 12px; color: #888; padding: 8px 5px; border-bottom: 1px solid #333; }
        .leaderboard-table td { padding: 10px 5px; border-bottom: 1px solid #222; }
        .leaderboard-table tr:last-child td { border-bottom: none; }
        .rank { font-weight: bold; color: #e94560; width: 30px; }
        .client-id { font-size: 13px; color: #ccc; }
        .score { font-weight: bold; color: #fff; text-align: right; }
        .delta { font-size: 11px; margin-left: 5px; }
        .delta.positive { color: #4ade80; }
        .delta.negative { color: #ef4444; }
        .delta.neutral { color: #888; }

        .my-score { background: #1e5128; border-radius: 8px; padding: 10px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; }
        .my-score-label { font-size: 12px; color: #888; }
        .my-score-value { font-size: 24px; font-weight: bold; color: #4ade80; }
    </style>
</head>
<body>
    <h1>Sports Micro-Predictions</h1>

    <div class="match-card">
        <div class="match-header">
            <span class="match-id" id="match-id">Match #1</span>
            <span class="period" id="period">Q1 - 15:00</span>
        </div>

        <div class="teams">
            <div class="team">
                <div class="team-label">Team A</div>
                <div class="team-name" id="team-a">ManU</div>
            </div>
            <div style="font-size: 24px; color: #e94560;">VS</div>
            <div class="team">
                <div class="team-label">Team B</div>
                <div class="team-name" id="team-b">Liverpool</div>
            </div>
        </div>

        <div class="question" id="question">Waiting for next event...</div>

        <div class="timer" id="timer-text">Next event in 3s...</div>
        <div class="timer-bar"><div class="timer-progress" id="timer-bar" style="width: 100%"></div></div>

        <div class="options" id="options" style="display: none;">
            <button class="option-btn team-a" id="btn-a">Team A</button>
            <button class="option-btn team-b" id="btn-b">Team B</button>
        </div>
    </div>

    <div class="status waiting" id="status">Connecting...</div>

    <div class="result-card" id="result-card">
        <div class="result-winner" id="result-winner"></div>
        <div class="result-ai" id="result-ai"></div>
        <div class="result-reason" id="result-reason"></div>
    </div>

    <div class="my-score">
        <div>
            <div class="my-score-label">Your Score</div>
            <div class="my-score-value" id="my-score">0</div>
        </div>
        <div style="text-align: right;">
            <div class="my-score-label">Streak</div>
            <div style="font-size: 20px; font-weight: bold; color: #fbbf24;" id="my-streak">0</div>
        </div>
    </div>

    <div class="leaderboard">
        <h2>Leaderboard</h2>
        <table class="leaderboard-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Client</th>
                    <th style="text-align: right;">Score</th>
                </tr>
            </thead>
            <tbody id="leaderboard-body"></tbody>
        </table>
    </div>

    <script>
        const clientId = \`client_\${Date.now()}_\${Math.random().toString(36).substr(2, 9)}\`;
        let myScore = 0;
        let myStreak = 0;
        let currentEventId = null;
        let hasPredicted = false;
        let timerInterval = null;
        let timerEndTime = 0;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

        ws.onopen = () => {
            console.log('WebSocket opened');
            setStatus('waiting', 'Connected. Waiting for event...');
        };

        ws.onerror = (event) => {
            console.error('WebSocket error', event);
            setStatus('waiting', 'WebSocket error. Check console.');
        };

        ws.onclose = (event) => {
            console.warn('WebSocket closed', event);
            setStatus('waiting', 'Disconnected. Refresh to reconnect.');
        };

        ws.onmessage = (event) => {
            console.log('WebSocket message received', event.data);
            const data = JSON.parse(event.data);

            if (data.type === 'NEW_EVENT') {
                handleNewEvent(data.event);
            } else if (data.type === 'EVENT_RESOLVED') {
                handleEventResolved(data);
            } else if (data.type === 'LEADERBOARD_UPDATE') {
                updateLeaderboard(data.leaderboard);
            }
        };

        ws.onclose = () => {
            setStatus('waiting', 'Disconnected. Refresh to reconnect.');
        };

        function handleNewEvent(event) {
            currentEventId = event.id;
            hasPredicted = false;

            document.getElementById('match-id').textContent = event.matchId;
            document.getElementById('period').textContent = event.period;
            document.getElementById('team-a').textContent = event.optionA;
            document.getElementById('team-b').textContent = event.optionB;
            document.getElementById('btn-a').textContent = event.optionA;
            document.getElementById('btn-b').textContent = event.optionB;
            document.getElementById('question').textContent = event.question;

            document.getElementById('options').style.display = 'flex';
            document.getElementById('btn-a').disabled = false;
            document.getElementById('btn-b').disabled = false;
            document.getElementById('btn-a').classList.remove('selected');
            document.getElementById('btn-b').classList.remove('selected');

            document.getElementById('result-card').classList.remove('show');

            const votingEnd = event.resolveAt;
            timerEndTime = votingEnd;
            startTimer();

            setStatus('waiting', 'Make your prediction!');
        }

        function handleEventResolved(data) {
            stopTimer();
            document.getElementById('options').style.display = 'none';

            const winner = data.winner;
            const annotations = data.annotations || [];
            const results = data.clientResults || {};

            document.getElementById('result-winner').textContent =
                winner === 'A' ? \`\${document.getElementById('team-a').textContent} Wins!\` :
                \`\${document.getElementById('team-b').textContent} Wins!\`;

            const aiAnnotation = annotations.find(a => a.source === 'ai');
            if (aiAnnotation) {
                document.getElementById('result-ai').textContent = \`AI Confidence: \${Math.round(aiAnnotation.confidence * 100)}%\`;
                document.getElementById('result-reason').textContent = aiAnnotation.reason || '';
            } else {
                document.getElementById('result-ai').textContent = '';
                document.getElementById('result-reason').textContent = '';
            }

            document.getElementById('result-card').classList.add('show');

            if (results[clientId]) {
                const { correct, points } = results[clientId];
                if (correct) {
                    myStreak++;
                    myScore += points;
                    setStatus('resolved', \`Correct! +\${points} points (\${myStreak} streak)\`);
                } else {
                    myStreak = 0;
                    myScore += points;
                    setStatus('resolved', \`Wrong. \${points} points. Streak reset.\`);
                }
                document.getElementById('my-score').textContent = myScore.toFixed(0);
                document.getElementById('my-streak').textContent = myStreak;
            } else {
                myStreak = 0;
                setStatus('resolved', 'You did not predict this event.');
            }
        }

        function updateLeaderboard(leaderboard) {
            const tbody = document.getElementById('leaderboard-body');
            tbody.innerHTML = '';

            leaderboard.forEach((client, index) => {
                if (client.id === clientId) {
                    myScore = client.score;
                    document.getElementById('my-score').textContent = myScore.toFixed(0);
                }

                const row = tbody.insertRow();
                row.insertCell(0).textContent = index + 1;
                row.cells[0].className = 'rank';

                const idCell = row.insertCell(1);
                idCell.textContent = client.id === clientId ? 'You' : client.id.substring(0, 15);
                idCell.className = 'client-id';

                const scoreCell = row.insertCell(2);
                scoreCell.className = 'score';
                scoreCell.textContent = client.score.toFixed(0);
            });
        }

        function setStatus(type, text) {
            const status = document.getElementById('status');
            status.className = \`status \${type}\`;
            status.textContent = text;
        }

        function predict(choice) {
            if (hasPredicted || !currentEventId) return;
            hasPredicted = true;

            document.getElementById('btn-a').disabled = true;
            document.getElementById('btn-b').disabled = true;
            document.getElementById(\`btn-\${choice.toLowerCase()}\`).classList.add('selected');

            const message = { type: 'PREDICT', clientId, choice };
            console.log('Sending prediction', message);
            ws.send(JSON.stringify(message));
            setStatus('predicted', \`Predicted \${choice === 'A' ? document.getElementById('team-a').textContent : document.getElementById('team-b').textContent}. Waiting for result...\`);
        }

        function startTimer() {
            if (timerInterval) clearInterval(timerInterval);

            timerInterval = setInterval(() => {
                const now = Date.now();
                const remaining = Math.max(0, timerEndTime - now);
                const total = 8000;
                const progress = (remaining / total) * 100;

                document.getElementById('timer-bar').style.width = \`\${progress}%\`;
                document.getElementById('timer-text').textContent = remaining > 0
                    ? \`Time left: \${(remaining / 1000).toFixed(1)}s\`
                    : 'Voting closed. Awaiting result...';
            }, 100);
        }

        function stopTimer() {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
        }

        document.getElementById('btn-a').onclick = () => predict('A');
        document.getElementById('btn-b').onclick = () => predict('B');
    </script>
</body>
</html>`;
