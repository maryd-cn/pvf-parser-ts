#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env');
const outPath = path.join(repoRoot, 'src', 'config', 'pvf', 'skillAnimationResources.json');
const PASSIVEOBJECT_LST = 'passiveobject/passiveobject.lst';

const SKILL_JOB_RESOURCES = {
  swordman: { character: 'swordman', animationDirs: ['animation', 'dsanimation'], sqrJobs: ['swordman'] },
  demonicswordman: { character: 'swordman', animationDirs: ['dsanimation', 'animation'], sqrJobs: ['demonicswordman', 'swordman'] },
  fighter: { character: 'fighter', animationDirs: ['animation'], sqrJobs: ['fighter'] },
  atfighter: { character: 'fighter', animationDirs: ['atanimation', 'animation'], sqrJobs: ['atfighter', 'fighter'] },
  gunner: { character: 'gunner', animationDirs: ['animation'], sqrJobs: ['gunner'] },
  atgunner: { character: 'gunner', animationDirs: ['atanimation', 'animation'], sqrJobs: ['atgunner', 'gunner'] },
  mage: { character: 'mage', animationDirs: ['animation'], sqrJobs: ['mage'] },
  atmage: { character: 'mage', animationDirs: ['atanimation', 'animation'], sqrJobs: ['atmage', 'mage'] },
  creatormage: { character: 'mage', animationDirs: ['creatoranimation', 'animation'], sqrJobs: ['creatormage', 'mage'] },
  priest: { character: 'priest', animationDirs: ['animation'], sqrJobs: ['priest', 'new_priest'] },
  thief: { character: 'thief', animationDirs: ['animation'], sqrJobs: ['thief'] },
};

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function normalizeKey(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').toLowerCase();
}

function archiveKey(root, fsPath) {
  return normalizeKey(path.relative(root, fsPath));
}

function safeJoin(root, key) {
  const parts = normalizeKey(key).split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part.includes('\0'))) return undefined;
  const full = path.resolve(root, ...parts);
  const rel = path.relative(path.resolve(root), full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return full;
}

function walkFiles(dir, suffix, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, suffix, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) out.push(full);
  }
  return out;
}

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function firstTaggedLine(text, tagName) {
  const pattern = new RegExp(`^[ \\t]*\\[${escapeRegExp(tagName)}\\][ \\t]*(?:\\r?\\n[ \\t]*([^\\r\\n]+)|[ \\t]+([^\\r\\n]+))`, 'im');
  const match = pattern.exec(text);
  return match?.[1] || match?.[2];
}

function cleanValue(value) {
  if (!value) return undefined;
  let text = String(value).trim();
  const quoted = text.match(/`([^`]*)`/);
  if (quoted) text = quoted[1];
  text = text.replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '').trim();
  return text || undefined;
}

function skillClass(text) {
  const raw = cleanValue(firstTaggedLine(text, 'skill class'));
  const match = raw && raw.match(/-?\d+/);
  return match ? match[0] : 'unknown';
}

function skillType(text) {
  return (cleanValue(firstTaggedLine(text, 'type')) || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skillResourceNames(job, baseName) {
  const names = [];
  const add = (value) => {
    const normalized = String(value || '').toLowerCase().trim();
    if (normalized && !names.includes(normalized)) names.push(normalized);
  };
  add(baseName);
  const bloodBlast = /^bloodblast(.*)$/i.exec(baseName);
  if ((job === 'swordman' || job === 'demonicswordman') && bloodBlast) add(`blastblood${bloodBlast[1] || ''}`);
  return names;
}

function skillObjectResourceNames(job, baseName) {
  const names = skillResourceNames(job, baseName).slice();
  const add = (value) => {
    const normalized = String(value || '').toLowerCase().trim();
    if (normalized && !names.includes(normalized)) names.push(normalized);
  };
  if ((job === 'swordman' || job === 'demonicswordman') && baseName === 'bloodsword') add('bloodswordexplosion');
  return names;
}

function skillInfo(skillKey) {
  const normalized = normalizeKey(skillKey);
  const match = /^skill\/([^/]+)\/(.+)\.skl$/i.exec(normalized);
  if (!match) return undefined;
  const job = match[1].toLowerCase();
  const baseName = path.posix.basename(match[2]).toLowerCase();
  const fallback = { character: job, animationDirs: ['animation'], sqrJobs: [job] };
  return {
    job,
    baseName,
    resourceNames: skillResourceNames(job, baseName),
    objNames: skillObjectResourceNames(job, baseName),
    jobResource: SKILL_JOB_RESOURCES[job] || fallback,
  };
}

function parseLst(root) {
  const file = safeJoin(root, PASSIVEOBJECT_LST);
  const out = [];
  if (!file || !fs.existsSync(file)) return out;
  const re = /(-?\d+)\s+`([^`]+\.obj)`/ig;
  const text = readText(file);
  let match;
  while ((match = re.exec(text))) out.push({ code: Number(match[1]), key: normalizeKey(match[2]) });
  return out;
}

function passiveJobs(skill) {
  return Array.from(new Set([skill.job, skill.jobResource.character].filter(Boolean).map(value => value.toLowerCase())));
}

function exactStem(key, names) {
  const stem = path.posix.basename(normalizeKey(key), '.obj').replace(/\.\[pvp\]$/i, '');
  return names.includes(stem);
}

function keyHasPassiveJob(key, jobs) {
  const normalized = normalizeKey(key);
  const match = /^passiveobject\/(?:character|actionobject)\/([^/]+)\/(.+\.obj)$/i.exec(normalized)
    || /^passiveobject\/([^/]+)\/(.+\.obj)$/i.exec(normalized);
  return !!match && jobs.includes(match[1].toLowerCase());
}

function findObjRefs(root, skill, passiveList) {
  const jobs = passiveJobs(skill);
  const fromList = passiveList
    .filter(item => keyHasPassiveJob(item.key, jobs) && exactStem(item.key, skill.objNames))
    .map(item => item.key);
  if (fromList.length) return Array.from(new Set(fromList)).sort();
  const dirs = [
    ...jobs.map(job => `passiveobject/${job}`),
    ...jobs.map(job => `passiveobject/character/${job}`),
    ...jobs.map(job => `passiveobject/actionobject/${job}`),
  ];
  const out = [];
  for (const dirKey of dirs) {
    const dir = safeJoin(root, dirKey);
    if (!dir || !fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.obj')) continue;
      const stem = entry.name.slice(0, -4).toLowerCase().replace(/\.\[pvp\]$/i, '');
      if (!skill.objNames.includes(stem)) continue;
      out.push(archiveKey(root, path.join(dir, entry.name)));
    }
  }
  return Array.from(new Set(out)).sort();
}

function findActRefs(root, skill) {
  const dirs = [
    `character/${skill.jobResource.character}/action`,
    ...passiveJobs(skill).map(job => `passiveobject/${job}`),
    ...passiveJobs(skill).map(job => `passiveobject/character/${job}`),
    ...passiveJobs(skill).map(job => `passiveobject/actionobject/${job}`),
  ];
  return findExactStemFiles(root, dirs, skill.resourceNames, '.act', 8);
}

function findAniRefs(root, skill) {
  const c = skill.jobResource.character;
  const dirs = [
    ...skill.jobResource.animationDirs.map(dir => `character/${c}/${dir}`),
    `character/${c}/effect/animation`,
    ...passiveJobs(skill).map(job => `passiveobject/${job}`),
    ...passiveJobs(skill).map(job => `passiveobject/character/${job}`),
    ...passiveJobs(skill).map(job => `passiveobject/actionobject/${job}`),
    'etc/ultimateskillani',
  ];
  return findExactStemFiles(root, dirs, skill.resourceNames, '.ani', 16);
}

function findAtkRefs(root, skill) {
  const c = skill.jobResource.character;
  const dirs = [
    `character/${c}/attackinfo`,
    `character/${c}/dsattackinfo`,
    ...passiveJobs(skill).map(job => `passiveobject/${job}/attackinfo`),
    ...passiveJobs(skill).map(job => `passiveobject/character/${job}/attackinfo`),
    ...passiveJobs(skill).map(job => `passiveobject/actionobject/${job}/attackinfo`),
  ];
  return findExactStemFiles(root, dirs, skill.resourceNames, '.atk', 16);
}

function findExactStemFiles(root, dirKeys, names, suffix, limit) {
  const out = [];
  for (const dirKey of dirKeys) {
    const dir = safeJoin(root, dirKey);
    if (!dir || !fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(suffix)) continue;
      if (entry.name.toLowerCase().endsWith('.ani.als')) continue;
      const stem = entry.name.slice(0, -suffix.length).toLowerCase().replace(/\.\[pvp\]$/i, '');
      if (!names.includes(stem)) continue;
      out.push(archiveKey(root, path.join(dir, entry.name)));
      if (out.length >= limit) return Array.from(new Set(out));
    }
  }
  return Array.from(new Set(out)).sort();
}

function preloadingImgs(text) {
  const out = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current = '';
  for (const raw of lines) {
    const trimmed = raw.trim();
    const tag = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (tag) {
      const name = tag[1].trim().toLowerCase();
      if (name.startsWith('/')) {
        current = '';
        continue;
      }
      current = name;
      if (current === 'skill preloading image') {
        const value = cleanValue(tag[2]);
        if (value && /\.img$/i.test(value)) out.push(normalizeKey(value));
      }
      continue;
    }
    if (current === 'skill preloading image') {
      const value = cleanValue(trimmed);
      if (value && /\.img$/i.test(value)) out.push(normalizeKey(value));
    }
  }
  return Array.from(new Set(out)).sort();
}

function build() {
  const env = parseEnv(fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '');
  const unpackDir = env.UNPACK_DIR || env.PVF_UNPACK_DIR || env.pvf_unpack_dir;
  if (!unpackDir) throw new Error('UNPACK_DIR is not configured in .env');
  const root = path.resolve(repoRoot, unpackDir);
  const skillRoot = safeJoin(root, 'skill');
  if (!skillRoot || !fs.existsSync(skillRoot)) throw new Error(`skill directory not found: ${skillRoot}`);
  const passiveList = parseLst(root);
  const skillFiles = walkFiles(skillRoot, '.skl').sort((a, b) => archiveKey(root, a).localeCompare(archiveKey(root, b), 'en'));
  const jobs = {};
  let mapped = 0;
  for (const file of skillFiles) {
    const key = archiveKey(root, file);
    const info = skillInfo(key);
    if (!info) continue;
    const text = readText(file);
    const cls = skillClass(text);
    const entry = {};
    const obj = findObjRefs(root, info, passiveList);
    const act = findActRefs(root, info);
    const ani = obj.length || act.length ? [] : findAniRefs(root, info);
    const atk = obj.length ? [] : findAtkRefs(root, info);
    const img = preloadingImgs(text);
    if (obj.length) entry.obj = obj;
    if (act.length) entry.act = act;
    if (ani.length) entry.ani = ani;
    if (atk.length) entry.atk = atk;
    if (img.length) entry.img = img;
    const job = jobs[info.job] || (jobs[info.job] = { skillClasses: {} });
    const classGroup = job.skillClasses[cls] || (job.skillClasses[cls] = { skills: {} });
    classGroup.skills[key] = entry;
    if (Object.keys(entry).some(k => Array.isArray(entry[k]) && entry[k].length)) mapped++;
  }
  const output = {
    $schema: './skillAnimationResources.schema.json',
    generatedFrom: normalizeKey(root),
    generatedAt: new Date().toISOString(),
    skillCount: skillFiles.length,
    mappedSkillCount: mapped,
    jobs,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`[skill-animation-resources] wrote ${outPath}`);
  console.log(`[skill-animation-resources] skills=${skillFiles.length} mapped=${mapped}`);
}

build();
