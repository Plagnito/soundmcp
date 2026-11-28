'use strict';

const { ui } = require('./language');
const { TOOLS } = require('./tools');
const { SoundMcpError } = require('./tool-errors');

const definitions = new Map(TOOLS.map((tool) => [tool.name, tool]));
const playSchema = definitions.get('play_sound').inputSchema;
const catalogFields = ['sounds', 'patch_paths', 'timbre', 'seed', 'output_dir'];
const catalogOnly = new Set(['sounds', 'patch_paths', 'timbre']);
const phrase = {
  ...playSchema,
  properties: Object.fromEntries(Object.entries(playSchema.properties).filter(([name]) => !catalogOnly.has(name))),
  oneOf: playSchema.oneOf.filter((branch) => !branch.required.includes('sounds')),
};
const catalog = {
  type: 'object', required: ['sounds'],
  properties: Object.fromEntries(catalogFields.map((name) => [name, playSchema.properties[name]])),
};

function operation(tool, label, schema = definitions.get(tool).inputSchema) {
  return { tool, label, schema };
}

const combinations = {
  audition_sound: {
    title: ui('Écouter des timbres', 'Audition sounds'),
    description: ui(
      'Écoute des timbres existants. Choisis mode=phrase avec instrument ou patch_path pour jouer des notes. Avec mode=catalog, sounds contient des identifiants et markers repère les exemples dans un seul WAV. Avec mode=comparison, sounds contient 2 à 4 objets de source et notes s’applique à toutes les prises. Reçois un WAV par timbre à sonie égale. Avec blind, garde seed pour reproduire l’ordre et ouvre reveal_path après le choix. Les WAV sont enregistrés dans un nouveau dossier. Utilise calibrate_sound pour mesurer un registre.',
      'Audition existing sounds. Choose mode=phrase with instrument or patch_path to play notes. With mode=catalog, sounds contains IDs and markers locates the examples in one WAV. With mode=comparison, sounds contains 2–4 source objects and notes applies to all takes. Get one WAV per sound at matched loudness. With blind, keep seed to reproduce the order and open reveal_path after the choice. WAVs go in a new folder. Use calibrate_sound to measure a register.',
    ),
    examples: [
      { mode: 'phrase', instrument: 'piano', notes: [{ at: 0, pitch: 'C4' }] },
      { mode: 'catalog', sounds: ['piano', 'harp'] },
      { mode: 'comparison', sounds: [{ instrument: 'flute' }, { instrument: 'clarinet' }],
        notes: [{ at: 0, pitch: 'A4' }], blind: true, seed: 7 },
    ],
    modes: {
      phrase: operation('play_sound', ui('Phrase avec un timbre', 'Phrase with one sound'), phrase),
      catalog: operation('play_sound', ui('Nuancier dans un seul WAV', 'Catalog tour in one WAV'), catalog),
      comparison: operation('compare_sounds', ui('Prises à sonie égale', 'Loudness-matched takes')),
    },
  },
  design_timbre: {
    title: ui('Créer ou décliner un patch', 'Design or vary a patch'),
    description: ui(
      'Écris des patches de synthèse réutilisables et leurs WAV de contrôle dans un nouveau dossier. Avec mode=create, donne brief ou patch, en choisissant layers, modal ou waveguide selon le matériau. Avec mode=vary, donne patch_path et une à quatre directions. amount applique chaque direction au patch source conservé, et les WAV sont alignés en sonie. Réimporte le patch_path choisi dans patch_paths. Utilise calibrate_sound pour régler les gains du pupitre.',
      'Write reusable synth patches and preview WAVs in a new folder. With mode=create, supply brief or patch using layers, modal, or waveguide for the material. With mode=vary, supply patch_path and one to four directions. amount applies each direction to the preserved source patch, and WAVs are loudness-matched. Import the chosen patch_path through patch_paths. Use calibrate_sound to adjust gains for a part.',
    ),
    examples: [
      { mode: 'create', brief: ui('Corde pincée douce', 'Soft plucked string') },
      { mode: 'vary', patch_path: 'timbre.soundmcp-patch.json', directions: ['brighter'], amount: 0.5 },
    ],
    modes: {
      create: operation('design_sound', ui('Nouveau patch', 'New patch')),
      vary: operation('vary_sound', ui('Variantes d’un patch existant', 'Variations of an existing patch')),
    },
  },
  render_preset: {
    title: ui('Rendre un preset sonore', 'Render a sound preset'),
    description: ui(
      'Rend un WAV 16 bits. Choisis mode=effect pour un son ponctuel ou mode=ambience pour un fond avec raccord de boucle. Donne soit kind de list_catalog, soit source_file_id d’un rendu du même mode. Avec replace, un même kind et seed peuvent écraser le WAV. Utilise unique pour un nouveau fichier ou reuse pour retrouver le rendu identique.',
      'Render a 16-bit WAV. Choose mode=effect for a one-shot or mode=ambience for a loopable sound bed. Pass either kind from list_catalog or source_file_id from an earlier render of the same mode. replace can overwrite the WAV for the same kind and seed. Use unique for a separate file or reuse for an identical prior render.',
    ),
    examples: [{ mode: 'effect', kind: 'coin' }, { mode: 'ambience', kind: 'rain', duration_seconds: 10 }],
    modes: {
      effect: operation('create_sfx', ui('Effet ponctuel', 'One-shot effect')),
      ambience: operation('create_ambience', ui('Boucle d’ambiance', 'Ambience loop')),
    },
  },
};

const profiles = {
  full: {},
  studio: { advanced: true },
  music: { advanced: true, names: [
    'list_catalog', 'draft_music', 'create_music', 'preview_music', 'compare_music_choices',
    'learn_music_preference', 'analyze_music', 'inspect_score', 'edit_music', 'finish_music', 'manage_outputs',
  ] },
  sound: { advanced: true, names: [
    'list_catalog', 'design_sound', 'play_sound', 'calibrate_sound', 'compare_sounds', 'vary_sound',
    'create_sfx', 'create_ambience', 'manage_outputs',
  ] },
  audition: { advanced: true, merge: ['audition_sound'] },
  patches: { advanced: true, merge: ['design_timbre'] },
  presets: { advanced: true, merge: ['render_preset'] },
  compact: { advanced: true, merge: Object.keys(combinations) },
};

function combinedDefinition(name, tools) {
  const { title, description, modes, examples } = combinations[name];
  const cases = Object.entries(modes);
  const siblings = [...new Set(cases.map(([, mode]) => tools.get(mode.tool)))];
  const modeLabel = cases.map(([mode, definition]) => `${mode} — ${definition.label}`).join('. ');
  const branches = cases.map(([mode, definition]) => {
    const base = definitions.get(definition.tool).inputSchema;
    const schema = definition.schema === base ? tools.get(definition.tool).inputSchema : definition.schema;
    return { ...schema, additionalProperties: false, required: ['mode', ...(schema.required ?? [])],
      properties: { ...schema.properties, mode: { const: mode } } };
  });
  const fields = new Map();
  for (const branch of branches) {
    for (const [field, schema] of Object.entries(branch.properties)) {
      if (field === 'mode') continue;
      if (!fields.has(field)) fields.set(field, new Map());
      fields.get(field).set(JSON.stringify(schema), schema);
    }
  }
  const properties = Object.fromEntries([...fields].map(([field, definitions]) => {
    const options = [...definitions.values()];
    return [field, options.length === 1 ? options[0] : { anyOf: options,
      description: ui('Choisis la forme correspondant au mode.', 'Choose the form that matches the mode.') }];
  }));
  return {
    name, title, description,
    inputSchema: {
      type: 'object',
      required: ['mode'],
      properties: { mode: { type: 'string', enum: Object.keys(modes), description: modeLabel }, ...properties },
      oneOf: branches, examples,
    },
    outputSchema: { type: 'object', anyOf: siblings.map((tool) => tool.outputSchema) },
    annotations: {
      readOnlyHint: false, destructiveHint: siblings.some((tool) => tool.annotations.destructiveHint),
      idempotentHint: false, openWorldHint: false,
    },
  };
}

function selectToolset(name = 'full', studioTools = TOOLS) {
  if (!Object.hasOwn(profiles, name)) {
    throw new SoundMcpError('UNKNOWN_TOOLSET', ui(
      `Profil SoundMCP inconnu « ${name} ». Profils disponibles ${Object.keys(profiles).join(', ')}.`,
      `Unknown SoundMCP toolset "${name}". Available toolsets ${Object.keys(profiles).join(', ')}.`,
    ));
  }
  const profile = profiles[name];
  const available = profile.advanced ? studioTools : TOOLS;
  if (profile.names) return profile.names.map((tool) => available.find(({ name }) => name === tool));
  const merges = profile.merge ?? [];
  if (!merges.length) return available;
  const tools = new Map(available.map((tool) => [tool.name, tool]));
  const replacements = new Map();
  for (const combined of merges) {
    const members = [...new Set(Object.values(combinations[combined].modes).map(({ tool }) => tool))];
    const first = available.find(({ name }) => members.includes(name)).name;
    for (const member of members) replacements.set(member, member === first ? combinedDefinition(combined, tools) : null);
  }
  return available.flatMap((tool) => {
    if (replacements.has(tool.name)) return replacements.get(tool.name) ?? [];
    const alternates = {
      play_sound: 'audition_sound (mode=phrase / catalog)', compare_sounds: 'audition_sound (mode=comparison)',
      design_sound: 'design_timbre (mode=create)', vary_sound: 'design_timbre (mode=vary)',
      create_sfx: 'render_preset (mode=effect)', create_ambience: 'render_preset (mode=ambience)',
    };
    const description = tool.description.replace(/\b(play_sound|compare_sounds|design_sound|vary_sound|create_sfx|create_ambience)\b/g,
      (name) => replacements.has(name) ? alternates[name] : name);
    return { ...tool, description };
  });
}

function resolveToolCall(name, args, studioTools = TOOLS) {
  if (!Object.hasOwn(combinations, name)) return { name, args };
  const definition = combinedDefinition(name, new Map(studioTools.map((tool) => [tool.name, tool])));
  const mode = args?.mode;
  const selected = Object.hasOwn(combinations[name].modes, mode) ? combinations[name].modes[mode] : undefined;
  const schema = definition.inputSchema.oneOf.find((branch) => branch.properties.mode.const === mode);
  if (!selected || !schema || Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some((key) => args[key] === undefined)) {
    throw new SoundMcpError('INCOMPATIBLE_PARAMETERS', ui(
      `Choisis les paramètres correspondant au mode de ${name}.`,
      `Choose the parameters for the selected ${name} mode.`,
    ), definition.inputSchema.properties.mode.description);
  }
  const { mode: ignored, ...forwarded } = args;
  return { name: selected.tool, args: forwarded };
}

module.exports = { selectToolset, resolveToolCall };
