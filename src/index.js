#!/usr/bin/env node
'use strict';

/**
 * SoundMCP — serveur MCP stdio (JSON-RPC 2.0, une ligne = un message).
 *
 * Ne rien écrire sur stdout autre que les réponses JSON ;
 * tous les logs vont sur stderr.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { TOOLS, callTool } = require('./tools');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const PROTOCOL_FALLBACK = '2025-06-18';

const INSTRUCTIONS = [
  'SoundMCP compose de la musique et des effets sonores pour jeux et médias.',
  'Outils : list_styles (catalogue), create_music (piste WAV/MIDI), create_sfx (effets).',
  'Flux conseillé : list_styles → create_music (choisis style/durée/tonalité) → itère en changeant le seed.',
  'La même graine (seed) reproduit exactement la même musique : note-le pour garder la version retenue.',
  'Pour un fond de jeu en continu, garde loop: true (boucle sans raccord).',
].join(' ');

const log = (...a) => {
  process.stderr.write(`[soundmcp] ${a.join(' ')}\n`);
};

const send = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

const respond = (id, result) => {
  if (id === undefined || id === null) return; // jamais de réponse à une notification
  send({ jsonrpc: '2.0', id, result });
};

const respondError = (id, code, message) => {
  if (id === undefined || id === null) {
    log(`erreur sans destinataire: ${code} ${message}`);
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code, message } });
};

/* ---------------------------------- handlers ---------------------------------- */

function initializeResult(params) {
  const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : PROTOCOL_FALLBACK;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'soundmcp', version: PKG.version },
    instructions: INSTRUCTIONS,
  };
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      respond(id, initializeResult(params));
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'initialized':
      return; // notification : rien à faire

    case 'ping':
      respond(id, {});
      return;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const result = await callTool(name, args);
        respond(id, result);
      } catch (err) {
        log(`outil ${name}: ${err.message}`);
        respond(id, {
          content: [{ type: 'text', text: `❌ ${err.message}` }],
          isError: true,
        });
      }
      return;
    }

    case 'logging/setLevel':
      respond(id, {});
      return;

    case 'resources/list':
      respond(id, { resources: [] });
      return;

    case 'prompts/list':
      respond(id, { prompts: [] });
      return;

    case 'completion/complete':
      respond(id, { completion: { values: [], hasMore: false } });
      return;

    case 'shutdown':
      respond(id, {});
      return;

    default:
      if (isNotification) return; // notifications inconnues : ignorées
      respondError(id, -32601, `Méthode inconnue: ${method}`);
  }
}

/* ---------------------------------- boucle stdio ---------------------------------- */

function main() {
  log(`v${PKG.version} — en attente sur stdin/stdout`);

  let queue = Promise.resolve();

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, `JSON invalide reçu sur stdin : ${trimmed.slice(0, 80)}`);
      return;
    }

    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      const id = msg && typeof msg === 'object' ? msg.id : null;
      respondError(id, -32600, 'Requête invalide : il faut jsonrpc="2.0", method et id.');
      return;
    }

    // Sérialise les traitements pour préserver l'ordre des réponses.
    const run = () => handleRequest(msg).catch((err) => {
      log(`erreur interne (${msg.method}): ${err.message}`);
      respondError(msg.id, -32603, `Erreur interne : ${err.message}`);
    });
    queue = queue.then(run, run);
  });

  rl.on('close', () => {
    log('stdin fermé, arrêt.');
    process.exit(0);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main();
