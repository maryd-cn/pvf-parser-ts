import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { parseScriptMetadata, normalizeImgLogical } from './metadata';
import { pathContains, readConfiguredNpkRoots } from './unpackEnv';

export type UnpackIconState = 'default' | 'loading' | 'ready' | 'missing' | 'error';

export interface UnpackIconReference {
  imagePath: string;
  frameIndex: number;
}

export interface UnpackResolvedMetadata {
  itemName?: string;
  itemCode?: number;
  rarity?: number;
  icon?: UnpackIconReference;
  iconPath?: string;
  iconState?: UnpackIconState;
}

export interface UnpackMetadataInput {
  fsPath: string;
  key: string;
  name: string;
  root: string;
  version: string;
}

interface MetadataCacheEntry {
  mtimeMs: number;
  size: number;
  metadata: UnpackResolvedMetadata;
}

interface LstCacheEntry {
  mtimeMs: number;
  size: number;
  fileToCode: Map<string, number>;
}

function quickHash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const m = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & m);
    }
  }
  return ~crc >>> 0;
}

function writePngChunk(type: string, data: Uint8Array, out: number[]): void {
  const len = data.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = new Uint8Array(typeBytes.length + data.length);
  chunk.set(typeBytes, 0);
  chunk.set(data, typeBytes.length);
  const crc = crc32(chunk);
  for (const byte of chunk) out.push(byte);
  out.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const out: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  writePngChunk('IHDR', ihdr, out);
  writePngChunk('IDAT', zlib.deflateSync(raw, { level: 9 }), out);
  writePngChunk('IEND', new Uint8Array(), out);
  return Buffer.from(out);
}

export function normalizeUnpackKey(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function safeJoinArchivePath(root: string, key: string): string | undefined {
  const parts = normalizeUnpackKey(key).split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '..' || part.includes('\0'))) return undefined;
  const fullPath = path.resolve(root, ...parts);
  return pathContains(root, fullPath) ? fullPath : undefined;
}

function stripPvfValue(value: string): string {
  let text = value.trim();
  const linkText = text.match(/`([^`]*)`/);
  if (linkText) text = linkText[1];
  if ((text.startsWith('`') && text.endsWith('`')) || (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

function tagValueToString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const stripped = stripPvfValue(item);
      if (stripped) return stripped;
    }
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const stripped = stripPvfValue(value);
  return stripped || undefined;
}

function tagValueToInt(value: string | string[] | undefined): number | undefined {
  const text = tagValueToString(value);
  if (!text) return undefined;
  const match = text.match(/-?\d+/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function codeFromFileName(key: string): number | undefined {
  const base = path.posix.basename(normalizeUnpackKey(key)).replace(/\.[^.]+$/, '');
  if (!/^\d+$/.test(base)) return undefined;
  const code = Number(base);
  return Number.isSafeInteger(code) ? code : undefined;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function lstCandidatesForKey(key: string): string[] {
  const normalized = normalizeUnpackKey(key);
  const first = normalized.split('/')[0] || '';
  const candidates: string[] = [];
  if (first === 'equipment') candidates.push('equipment/equipment.lst');
  if (first === 'stackable') candidates.push('stackable/stackable.lst');
  if (first === 'skill') candidates.push('skill/skill.lst');
  if (first === 'creature') candidates.push('creature/creature.lst');
  if (first === 'n_quest' || normalized.endsWith('.qst')) candidates.push('n_quest/quest.lst', 'n_quest/n_quest.lst');
  if (first) candidates.push(`${first}/${first}.lst`);
  return unique(candidates);
}

async function readUtf8Text(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  let text = Buffer.from(buf).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export async function readLstFileToCodeMap(lstDiskPath: string): Promise<Map<string, number>> {
  const text = await readUtf8Text(lstDiskPath);
  const fileToCode = new Map<string, number>();
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(-?\d+)\s+`?([^`]+)`?/);
    if (!match) continue;
    const code = Number(match[1]);
    if (!Number.isSafeInteger(code)) continue;
    fileToCode.set(normalizeUnpackKey(match[2]), code);
  }
  return fileToCode;
}

export function parseUnpackScriptText(text: string): Omit<UnpackResolvedMetadata, 'itemCode' | 'iconPath' | 'iconState'> {
  if (!/\[(name|name2|icon|rarity|grade)\]/i.test(text)) return {};
  const parsed = parseScriptMetadata(text);
  const itemName = parsed.name || parsed.name2 || tagValueToString(parsed.tags?.['set name']);
  const rarity = tagValueToInt(parsed.tags?.rarity);
  const icon = parsed.icon
    ? { imagePath: normalizeImgLogical(parsed.icon.img), frameIndex: parsed.icon.frame }
    : undefined;
  return {
    ...(itemName ? { itemName } : {}),
    ...(typeof rarity === 'number' ? { rarity } : {}),
    ...(icon ? { icon } : {}),
  };
}

function configBool(primary: string, legacy: string, fallback: boolean): boolean {
  const cfg = vscode.workspace.getConfiguration();
  const primaryValue = cfg.get<boolean>(primary);
  if (typeof primaryValue === 'boolean') return primaryValue;
  const legacyValue = cfg.get<boolean>(legacy);
  return typeof legacyValue === 'boolean' ? legacyValue : fallback;
}

function configNumber(primary: string, legacy: string, fallback: number): number {
  const cfg = vscode.workspace.getConfiguration();
  const primaryValue = cfg.get<number>(primary);
  const legacyValue = cfg.get<number>(legacy);
  const raw = Number.isFinite(primaryValue) ? primaryValue : legacyValue;
  return Number.isFinite(raw) ? Math.max(16, Math.min(64, Math.floor(raw as number))) : fallback;
}

function configStringArray(primary: string, legacy: string): string[] {
  const cfg = vscode.workspace.getConfiguration();
  const primaryValue = cfg.get<unknown>(primary);
  const legacyValue = cfg.get<unknown>(legacy);
  const raw = Array.isArray(primaryValue) && primaryValue.length > 0 ? primaryValue : legacyValue;
  return Array.isArray(raw) ? raw.map(item => String(item || '').trim()).filter(Boolean) : [];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export class UnpackMetadataService {
  private readonly metadataCache = new Map<string, MetadataCacheEntry>();
  private readonly lstCache = new Map<string, LstCacheEntry>();
  private readonly lstPromises = new Map<string, Promise<LstCacheEntry | undefined>>();
  private readonly iconPromises = new Map<string, Promise<string | undefined>>();
  private npkRootsCache: Promise<string[]> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output?: vscode.OutputChannel,
  ) {}

  clear(): void {
    this.metadataCache.clear();
    this.lstCache.clear();
    this.lstPromises.clear();
    this.iconPromises.clear();
    this.npkRootsCache = undefined;
  }

  getCached(input: UnpackMetadataInput): UnpackResolvedMetadata | undefined {
    return this.metadataCache.get(this.cacheKey(input))?.metadata;
  }

  async resolveMetadata(input: UnpackMetadataInput): Promise<UnpackResolvedMetadata> {
    const stat = await fs.stat(input.fsPath);
    const cacheKey = this.cacheKey(input);
    const cached = this.metadataCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.metadata;

    const text = await readUtf8Text(input.fsPath);
    const parsed = parseUnpackScriptText(text);
    const itemCode = await this.resolveItemCode(input);
    const metadata: UnpackResolvedMetadata = {
      ...parsed,
      ...(typeof itemCode === 'number' ? { itemCode } : {}),
      ...(parsed.icon ? { iconState: 'default' as UnpackIconState } : {}),
    };
    this.metadataCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, metadata });
    return metadata;
  }

  async resolveIcon(input: UnpackMetadataInput): Promise<UnpackResolvedMetadata | undefined> {
    const entry = this.metadataCache.get(this.cacheKey(input));
    const metadata = entry?.metadata;
    if (!metadata?.icon) return metadata;
    if (metadata.iconPath && metadata.iconState === 'ready') return metadata;
    if (!configBool('pvf.unpackExplorer.npkIcon.enabled', 'pvfExplorer.npkIcon.enabled', true)) {
      metadata.iconState = 'default';
      return metadata;
    }

    metadata.iconState = 'loading';
    try {
      const iconPath = await this.decodeIcon(metadata.icon);
      if (iconPath) {
        metadata.iconPath = iconPath;
        metadata.iconState = 'ready';
      } else {
        metadata.iconState = 'missing';
      }
    } catch (err: any) {
      metadata.iconState = 'error';
      this.output?.appendLine(`[PVF] failed to decode unpack icon ${input.key}: ${String(err && err.message || err)}`);
    }
    return metadata;
  }

  private cacheKey(input: UnpackMetadataInput): string {
    return `${path.resolve(input.root)}\0${normalizeUnpackKey(input.key)}\0${input.version}`;
  }

  private async resolveItemCode(input: UnpackMetadataInput): Promise<number | undefined> {
    const key = normalizeUnpackKey(input.key);
    for (const lstKey of lstCandidatesForKey(key)) {
      const lstPath = safeJoinArchivePath(input.root, lstKey);
      if (!lstPath) continue;
      const entry = await this.loadLst(lstPath);
      const code = entry?.fileToCode.get(key);
      if (typeof code === 'number') return code;
    }
    return codeFromFileName(key);
  }

  private async loadLst(lstDiskPath: string): Promise<LstCacheEntry | undefined> {
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(lstDiskPath);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }

    const cached = this.lstCache.get(lstDiskPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

    const existing = this.lstPromises.get(lstDiskPath);
    if (existing) return existing;

    const promise = readLstFileToCodeMap(lstDiskPath)
      .then(fileToCode => {
        const entry = { mtimeMs: stat.mtimeMs, size: stat.size, fileToCode };
        this.lstCache.set(lstDiskPath, entry);
        return entry;
      })
      .catch((err: any) => {
        this.output?.appendLine(`[PVF] failed to read unpack lst ${lstDiskPath}: ${String(err && err.message || err)}`);
        return undefined;
      })
      .finally(() => this.lstPromises.delete(lstDiskPath));
    this.lstPromises.set(lstDiskPath, promise);
    return promise;
  }

  private async getNpkRoots(): Promise<string[]> {
    if (!this.npkRootsCache) {
      this.npkRootsCache = (async () => {
        const cfg = vscode.workspace.getConfiguration();
        const settingRoots = configStringArray('pvf.unpackExplorer.npkIcon.paths', 'pvfExplorer.npkIcon.paths');
        const envRoots = await readConfiguredNpkRoots(this.context);
        const legacyRoot = (cfg.get<string>('pvf.npkRoot') || '').trim();
        return unique([...settingRoots, ...envRoots, ...(legacyRoot ? [legacyRoot] : [])]);
      })();
    }
    return this.npkRootsCache;
  }

  private async decodeIcon(icon: UnpackIconReference): Promise<string | undefined> {
    const roots = await this.getNpkRoots();
    if (roots.length === 0) return undefined;
    const size = configNumber('pvf.unpackExplorer.npkIcon.size', 'pvfExplorer.npkIcon.size', 20);
    const cacheEnabled = configBool('pvf.unpackExplorer.npkIcon.cache.enabled', 'pvfExplorer.npkIcon.cache.enabled', true);
    const sessionNonce = cacheEnabled ? 'cache' : `${Date.now()}:${Math.random()}`;
    const promiseKey = `${roots.join('|')}\0${icon.imagePath}\0${icon.frameIndex}\0${size}\0${sessionNonce}`;
    const existing = this.iconPromises.get(promiseKey);
    if (existing) return existing;

    const promise = this.decodeIconUncached(roots, icon, promiseKey, cacheEnabled)
      .finally(() => this.iconPromises.delete(promiseKey));
    this.iconPromises.set(promiseKey, promise);
    return promise;
  }

  private async decodeIconUncached(
    roots: string[],
    icon: UnpackIconReference,
    cacheKeyInput: string,
    cacheEnabled: boolean,
  ): Promise<string | undefined> {
    const hash = quickHash(`${cacheKeyInput}\0unpack-png-v1`);
    const cacheDir = path.join(this.context.globalStorageUri.fsPath, 'unpack-icon-cache');
    const filePath = path.join(cacheDir, `${hash}.png`);
    if (cacheEnabled && await fileExists(filePath)) return filePath;

    const { loadAlbumForImage } = await import('../commander/previewAni/npkResolver.js');
    const { getSpriteRgba } = await import('../npk/imgReader.js');
    for (const root of roots) {
      const album = await loadAlbumForImage(this.context, root, icon.imagePath, this.output).catch(() => undefined);
      const sprite = album?.sprites?.[icon.frameIndex];
      if (!album || !sprite) continue;
      const rgba = getSpriteRgba(album as any, icon.frameIndex);
      if (!rgba) continue;
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(filePath, encodePng(rgba, sprite.width, sprite.height));
      return filePath;
    }
    return undefined;
  }
}
