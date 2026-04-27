var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { DurableObject } from "cloudflare:workers";

// src/eventEngine.ts
var TEAMS = [
  ["Manchester United", "Liverpool"],
  ["Real Madrid", "Barcelona"],
  ["Bayern Munich", "Borussia Dortmund"],
  ["PSG", "Marseille"],
  ["Juventus", "AC Milan"],
  ["Chelsea", "Arsenal"],
  ["Atletico Madrid", "Sevilla"],
  ["Inter Milan", "Napoli"]
];
var PERIODS = ["Q1 - 15:00", "Q1 - 30:00", "Q2 - 45:00", "Q2 - 60:00", "Q3 - 75:00", "Q4 - 90:00"];
var QUESTIONS = [
  "Who will score the next goal?",
  "Who will get the next corner kick?",
  "Who will commit the next foul?",
  "Who will get the next yellow card?",
  "Who will win the next throw-in?",
  "Who will make the next substitution?"
];
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
__name(randomItem, "randomItem");
function generateFootballEvent() {
  const [teamA, teamB] = randomItem(TEAMS);
  const now = Date.now();
  return {
    id: `event_${now}_${Math.random().toString(36).substr(2, 6)}`,
    matchId: `match_${Math.floor(now / 6e4)}`,
    teamA,
    teamB,
    period: randomItem(PERIODS),
    question: randomItem(QUESTIONS),
    optionA: teamA,
    optionB: teamB,
    annotations: [],
    answers: {},
    createdAt: now,
    resolveAt: now + 8e3,
    resolved: false
  };
}
__name(generateFootballEvent, "generateFootballEvent");

// src/scoring.ts
function calculateScore(correct, choice, answers, streak) {
  if (!correct) return -10;
  const total = Object.keys(answers).length || 1;
  const sameChoice = Object.values(answers).filter((a) => a === choice).length;
  const consensus = sameChoice / total;
  const points = 100 * (1 - consensus) * (1 + 0.1 * streak);
  return Math.round(points);
}
__name(calculateScore, "calculateScore");
function resolveWinner(event) {
  const answers = Object.values(event.answers);
  if (answers.length === 0) {
    return Math.random() < 0.5 ? "A" : "B";
  }
  const countA = answers.filter((a) => a === "A").length;
  const countB = answers.filter((a) => a === "B").length;
  if (countA === countB) {
    return Math.random() < 0.5 ? "A" : "B";
  }
  return countA > countB ? "A" : "B";
}
__name(resolveWinner, "resolveWinner");
async function annotateEvent(event) {
  const answers = Object.values(event.answers);
  const countA = answers.filter((a) => a === "A").length;
  const countB = answers.filter((a) => a === "B").length;
  const answer = countA >= countB ? "A" : "B";
  const confidence = 0.65 + Math.random() * 0.3;
  const reasons = [
    `${answer === "A" ? event.teamA : event.teamB} has shown stronger performance recently.`,
    `Statistical analysis favors ${answer === "A" ? event.teamA : event.teamB} in this situation.`,
    `Historical data suggests ${answer === "A" ? event.teamA : event.teamB} tends to dominate here.`,
    `Current match momentum is with ${answer === "A" ? event.teamA : event.teamB}.`
  ];
  return {
    source: "ai",
    answer,
    confidence: Math.round(confidence * 100) / 100,
    reason: reasons[Math.floor(Math.random() * reasons.length)]
  };
}
__name(annotateEvent, "annotateEvent");

// src/index.ts
var MatchRoom = class extends DurableObject {
  static {
    __name(this, "MatchRoom");
  }
  currentEvent;
  clientStates = /* @__PURE__ */ new Map();
  eventLoopTimer;
  resolveTimer;
  constructor(ctx, env) {
    super(ctx, env);
    console.log("MatchRoom constructed", { id: ctx.id.toString() });
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
  startEventLoop() {
    console.log("MatchRoom starting event loop");
    this.scheduleNextEvent();
  }
  clearTimers() {
    if (this.eventLoopTimer) {
      clearTimeout(this.eventLoopTimer);
      this.eventLoopTimer = void 0;
    }
    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
      this.resolveTimer = void 0;
    }
  }
  scheduleNextEvent() {
    this.clearTimers();
    this.eventLoopTimer = setTimeout(() => {
      this.generateNewEvent().catch((error) => console.error("generateNewEvent failed", error));
    }, 3e3);
  }
  async generateNewEvent() {
    this.currentEvent = generateFootballEvent();
    console.log("Generated new event", {
      id: this.currentEvent.id,
      question: this.currentEvent.question,
      resolveAt: this.currentEvent.resolveAt
    });
    this.broadcastToAll({ type: "NEW_EVENT", event: this.currentEvent });
    if (this.resolveTimer) {
      clearTimeout(this.resolveTimer);
    }
    this.resolveTimer = setTimeout(() => {
      console.log("Resolve timer fired for event", this.currentEvent?.id);
      this.resolveCurrentEvent().catch((error) => console.error("resolveCurrentEvent failed", error));
    }, 8e3);
    try {
      await this.ctx.storage.setAlarm(this.currentEvent.resolveAt);
      console.log("Set alarm for event resolution", { eventId: this.currentEvent.id, resolveAt: this.currentEvent.resolveAt });
    } catch (error) {
      console.error("Failed to schedule durable alarm", error);
    }
  }
  async resolveCurrentEvent() {
    if (!this.currentEvent) {
      console.log("resolveCurrentEvent called but no currentEvent");
      return;
    }
    try {
      const event = this.currentEvent;
      console.log("Resolving event", { id: event.id, answers: event.answers });
      event.resolved = true;
      const annotation = await annotateEvent(event);
      event.annotations.push(annotation);
      const winner = resolveWinner(event);
      event.correctAnswer = winner;
      const clientResults = {};
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
        type: "EVENT_RESOLVED",
        eventId: event.id,
        winner,
        annotations: event.annotations,
        clientResults
      });
      await this.broadcastLeaderboard();
      this.currentEvent = void 0;
      this.scheduleNextEvent();
    } catch (error) {
      console.error("Failed resolving current event", error);
    }
  }
  getOrCreateClientState(clientId) {
    const existing = this.clientStates.get(clientId);
    if (existing) return existing;
    return { score: 0, streak: 0, lastResult: null };
  }
  async saveClientState(clientId, state) {
    await this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO clients (id, score, streak, last_result) VALUES ('${clientId}', ${state.score}, ${state.streak}, ${state.lastResult})`);
    this.clientStates.set(clientId, state);
  }
  async broadcastLeaderboard() {
    const clients = await this.ctx.storage.sql.exec("SELECT id, score FROM clients ORDER BY score DESC LIMIT 50");
    const clientRows = await clients.toArray();
    console.log("Broadcasting leaderboard rows", clientRows.length);
    const leaderboard = clientRows.map((row) => ({
      id: row.id,
      score: row.score ?? 0,
      delta: 0
    }));
    this.broadcastToAll({ type: "LEADERBOARD_UPDATE", leaderboard });
  }
  broadcastToAll(message) {
    const webSockets = this.ctx.getWebSockets();
    if (webSockets.length === 0) {
      console.log("No open websockets to broadcast message", message.type);
      return;
    }
    for (const ws of webSockets) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error("Failed to send websocket message", error, message.type);
      }
    }
  }
  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      console.log("Accepting websocket connection");
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("MatchRoom ready");
  }
  async webSocketMessage(ws, msg) {
    try {
      const data = JSON.parse(msg);
      console.log("Received websocket message", data);
      if (data.type === "PREDICT" && this.currentEvent && !this.currentEvent.resolved) {
        const { clientId, choice } = data;
        if (choice === "A" || choice === "B") {
          if (!this.currentEvent.answers[clientId]) {
            this.currentEvent.answers[clientId] = choice;
            console.log("Recorded prediction", { eventId: this.currentEvent.id, clientId, choice });
          } else {
            console.log("Prediction ignored: already predicted", { eventId: this.currentEvent.id, clientId });
          }
        }
      }
    } catch (e) {
      console.error("Invalid message", e);
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    console.log("WebSocket closed", code, reason, wasClean);
  }
  async alarm(alarmInfo) {
    console.log("MatchRoom alarm triggered", { eventId: this.currentEvent?.id, alarmInfo });
    if (this.currentEvent && !this.currentEvent.resolved) {
      await this.resolveCurrentEvent();
    } else {
      console.log("Alarm fired with no active event, scheduling next event");
      this.scheduleNextEvent();
    }
  }
};
var src_default = {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      const stub = env.MATCH_ROOM.getByName("room");
      return stub.fetch(request);
    }
    return new Response(INDEX_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};
var INDEX_HTML = `<!DOCTYPE html>
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
    <\/script>
</body>
</html>`;

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-ekKAaQ/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-ekKAaQ/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  MatchRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
