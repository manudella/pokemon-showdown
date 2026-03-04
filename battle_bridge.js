/**
 * Battle Bridge - JSON-lines subprocess protocol for managing concurrent battles.
 *
 * Communicates with Python over stdin/stdout using newline-delimited JSON.
 * Each battle runs in a separate BattleStream (no WebSocket server needed).
 *
 * Protocol (stdin, Python → Node):
 *   {"type":"create","battle_id":"b0","format":"gen9vgc2026regf","p1_team":"packed...","p2_team":"packed...","seed":[1,2,3,4]}
 *   {"type":"team","battle_id":"b0","player":"p1","choice":"1234"}
 *   {"type":"choose","battle_id":"b0","player":"p1","choice":"move 1 +2, move 2 +1"}
 *   {"type":"destroy","battle_id":"b0"}
 *   {"type":"shutdown"}
 *
 * Protocol (stdout, Node → Python):
 *   {"type":"teampreview","battle_id":"b0","player":"p1","request":{...}}
 *   {"type":"request","battle_id":"b0","player":"p1","request":{...}}
 *   {"type":"protocol","battle_id":"b0","player":"p1","lines":["...",...]}}
 *   {"type":"end","battle_id":"b0","winner":"p1"|"p2"|null}
 *   {"type":"error","battle_id":"b0","message":"..."}
 *   {"type":"ready"}
 */

'use strict';

const { BattleStream, getPlayerStreams } = require('./dist/sim');
const readline = require('readline');

const battles = new Map();

function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleCreate(msg) {
    const { battle_id, format, p1_team, p2_team, seed } = msg;

    if (battles.has(battle_id)) {
        send({ type: 'error', battle_id, message: `Battle ${battle_id} already exists` });
        return;
    }

    const stream = new BattleStream({ debug: false });
    const streams = getPlayerStreams(stream);
    const battle = { stream, streams, ended: false };
    battles.set(battle_id, battle);

    // Listen on p1 stream
    (async () => {
        try {
            for await (const chunk of streams.p1) {
                processPlayerChunk(battle_id, 'p1', chunk, battle);
            }
        } catch (err) {
            send({ type: 'error', battle_id, message: `p1 stream error: ${err.message}` });
        }
    })();

    // Listen on p2 stream
    (async () => {
        try {
            for await (const chunk of streams.p2) {
                processPlayerChunk(battle_id, 'p2', chunk, battle);
            }
        } catch (err) {
            send({ type: 'error', battle_id, message: `p2 stream error: ${err.message}` });
        }
    })();

    // Listen for end on omniscient stream
    (async () => {
        try {
            for await (const chunk of streams.omniscient) {
                // Check for win/tie in the omniscient stream
                for (const line of chunk.split('\n')) {
                    if (line.startsWith('|win|')) {
                        const winnerName = line.slice(5);
                        // Determine p1 or p2 from the winner name
                        battle.ended = true;
                        // Winner resolved in processPlayerChunk via |win| line
                    } else if (line === '|tie') {
                        battle.ended = true;
                    }
                }
            }
        } catch (err) {
            // Stream ended - normal
        }
    })();

    // Start the battle
    const startOpts = { formatid: format };
    if (seed) startOpts.seed = seed;
    streams.omniscient.write(`>start ${JSON.stringify(startOpts)}`);
    streams.omniscient.write(`>player p1 ${JSON.stringify({ name: 'p1', team: p1_team })}`);
    streams.omniscient.write(`>player p2 ${JSON.stringify({ name: 'p2', team: p2_team })}`);
}

function processPlayerChunk(battle_id, player, chunk, battle) {
    const lines = chunk.split('\n');
    const protocolLines = [];
    let request = null;
    let isTeamPreview = false;
    let winner = null;
    let isTie = false;

    for (const line of lines) {
        if (!line) continue;

        if (line.startsWith('|request|')) {
            try {
                request = JSON.parse(line.slice(9));
                isTeamPreview = !!request.teamPreview;
            } catch (e) {
                // Skip malformed requests
            }
        } else if (line.startsWith('|win|')) {
            const winnerName = line.slice(5);
            winner = winnerName; // "p1" or "p2" (we set name=player id)
            protocolLines.push(line);
        } else if (line === '|tie') {
            isTie = true;
            protocolLines.push(line);
        } else if (line.startsWith('|error|')) {
            send({ type: 'error', battle_id, player, message: line.slice(7) });
        } else {
            protocolLines.push(line);
        }
    }

    // Send protocol lines (battle events)
    if (protocolLines.length > 0) {
        send({ type: 'protocol', battle_id, player, lines: protocolLines });
    }

    // Send request (choice request)
    if (request) {
        if (isTeamPreview) {
            send({ type: 'teampreview', battle_id, player, request });
        } else {
            send({ type: 'request', battle_id, player, request });
        }
    }

    // Send end
    if (winner !== null) {
        send({ type: 'end', battle_id, winner });
    } else if (isTie) {
        send({ type: 'end', battle_id, winner: null });
    }
}

function handleChoose(msg) {
    const { battle_id, player, choice } = msg;
    const battle = battles.get(battle_id);
    if (!battle) {
        send({ type: 'error', battle_id, message: `Battle ${battle_id} not found` });
        return;
    }
    battle.streams[player].write(choice);
}

function handleTeam(msg) {
    // Team preview choice - same as choose but semantically distinct
    handleChoose(msg);
}

function handleDestroy(msg) {
    const { battle_id } = msg;
    const battle = battles.get(battle_id);
    if (battle) {
        try {
            battle.stream.writeEnd();
        } catch (e) {
            // Already ended
        }
        battles.delete(battle_id);
    }
}

// Set up line reader on stdin
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});

rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;

    let msg;
    try {
        msg = JSON.parse(line);
    } catch (e) {
        send({ type: 'error', battle_id: null, message: `Invalid JSON: ${e.message}` });
        return;
    }

    switch (msg.type) {
        case 'create':
            handleCreate(msg);
            break;
        case 'choose':
            handleChoose(msg);
            break;
        case 'team':
            handleTeam(msg);
            break;
        case 'destroy':
            handleDestroy(msg);
            break;
        case 'shutdown':
            // Clean up all battles
            for (const [id, battle] of battles) {
                try { battle.stream.writeEnd(); } catch (e) {}
            }
            battles.clear();
            process.exit(0);
            break;
        default:
            send({ type: 'error', battle_id: msg.battle_id, message: `Unknown type: ${msg.type}` });
    }
});

rl.on('close', () => {
    process.exit(0);
});

// Signal ready
send({ type: 'ready' });
