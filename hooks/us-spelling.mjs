#!/usr/bin/env node
// PostToolUse on Write|Edit: flag British spellings in text Claude just wrote.
// Exits 2 with the findings on stderr, which Claude Code feeds back to the model.
// A file containing `us-spelling:ignore` is skipped.

// Explicit words only. A generic -ise/-our rule matches surprise, promise, four,
// your, flour and glamour, so the false positives would train the hook out of use.
export const SWAPS = {
  colour: 'color', colours: 'colors', coloured: 'colored', colouring: 'coloring',
  behaviour: 'behavior', behaviours: 'behaviors', behavioural: 'behavioral',
  favour: 'favor', favours: 'favors', favourite: 'favorite', favourable: 'favorable',
  honour: 'honor', labour: 'labor', neighbour: 'neighbor', neighbours: 'neighbors',
  flavour: 'flavor', humour: 'humor', rumour: 'rumor', endeavour: 'endeavor',
  armour: 'armor', vapour: 'vapor', harbour: 'harbor', odour: 'odor', tumour: 'tumor',
  organise: 'organize', organised: 'organized', organising: 'organizing',
  recognise: 'recognize', recognised: 'recognized', recognises: 'recognizes',
  analyse: 'analyze', analysed: 'analyzed', analyses: 'analyzes', analysing: 'analyzing',
  apologise: 'apologize', prioritise: 'prioritize', summarise: 'summarize',
  categorise: 'categorize', normalise: 'normalize', initialise: 'initialize',
  serialise: 'serialize', optimise: 'optimize', customise: 'customize',
  minimise: 'minimize', maximise: 'maximize', realise: 'realize', realised: 'realized',
  emphasise: 'emphasize', utilise: 'utilize', visualise: 'visualize',
  standardise: 'standardize', authorise: 'authorize', memorise: 'memorize',
  licence: 'license', practise: 'practice', practised: 'practiced',
  defence: 'defense', offence: 'offense', pretence: 'pretense',
  grey: 'gray', greyed: 'grayed', centre: 'center', centred: 'centered',
  metre: 'meter', metres: 'meters', fibre: 'fiber', litre: 'liter',
  catalogue: 'catalog', catalogued: 'cataloged', programme: 'program',
  artefact: 'artifact', artefacts: 'artifacts', sceptic: 'skeptic', sceptical: 'skeptical',
  cancelled: 'canceled', cancelling: 'canceling', travelled: 'traveled',
  travelling: 'traveling', modelling: 'modeling', labelled: 'labeled',
  labelling: 'labeling', fuelled: 'fueled', signalling: 'signaling',
  marvellous: 'marvelous', learnt: 'learned', spelt: 'spelled',
  whilst: 'while', amongst: 'among', aluminium: 'aluminum',
  manoeuvre: 'maneuver', enrolment: 'enrollment', fulfil: 'fulfill',
};

const RE = new RegExp(`\\b(${Object.keys(SWAPS).join('|')})\\b`, 'gi');

export function findBritishisms(text) {
  if (typeof text !== 'string' || text.includes('us-spelling:ignore')) return [];
  const seen = new Map();
  for (const m of text.matchAll(RE)) {
    const word = m[0];
    const key = word.toLowerCase();
    if (!seen.has(key)) seen.set(key, { word, fix: SWAPS[key] });
  }
  return [...seen.values()];
}

export function writtenText(payload) {
  const i = payload?.tool_input ?? {};
  if (payload?.tool_name === 'Write') return i.content ?? '';
  if (payload?.tool_name === 'Edit') return i.new_string ?? '';
  return '';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let p; try { p = JSON.parse(raw); } catch { process.exit(0); }
  if (p?.tool_name !== 'Write' && p?.tool_name !== 'Edit') process.exit(0);

  const hits = findBritishisms(writtenText(p));
  if (hits.length === 0) process.exit(0);

  const list = hits.map((h) => `${h.word} -> ${h.fix}`).join(', ');
  const path = p?.tool_input?.file_path ?? 'the file';
  process.stderr.write(
    `British spelling in ${path}: ${list}. The user writes US English; ` +
    `fix these now with an Edit, and watch for the same words in chat.\n`,
  );
  process.exit(2);
}
