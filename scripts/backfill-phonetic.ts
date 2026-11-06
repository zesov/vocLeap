/**
 * Backfill `words.phonetic` with IPA transcriptions.
 *
 * Sources, tried in order:
 *   1. English Wiktionary wikitext — authoritative, covers most lemmas.
 *   2. CMUdict (ARPAbet converted to IPA) — covers inflected forms and pages
 *      where Wiktionary only has `{{rfp|en}}` ("pronunciation requested").
 *   3. Composition — multi-word entries are built from their tokens
 *      ("look up" -> /ˌlʊk ˈʌp/).
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/backfill-phonetic.ts             # dry run
 *   node --env-file-if-exists=.env scripts/backfill-phonetic.ts --write     # persist
 *
 * Flags:
 *   --write        Persist the results (default is a dry run).
 *   --overwrite    Also replace rows that already have a phonetic.
 *   --limit=N      Only process the first N candidates.
 *   --sample=N     How many proposed values to print (default 25).
 *   --verbose      Print every word that could not be resolved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { db, initDatabase } from "../lib/db/init.ts";

const WIKTIONARY_API = "https://en.wiktionary.org/w/api.php";
const WIKTIONARY_BATCH_SIZE = 50;
const WIKTIONARY_DELAY_MS = 900;
const USER_AGENT = "Vocleap-PhoneticBackfill/1.0 (dictionary maintenance)";

const CMUDICT_URL =
  "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict";
const CMUDICT_CACHE = "data/cmudict.dict";

/** Test/import artefacts such as `w0_1793759405056` are not words. */
const ARTEFACT_RE = /_\d{10,}$/;

const EN_LANGUAGE_CODES = new Set([
  "en", "en-us", "en-gb", "en-uk", "en-au", "en-ca", "en-ie", "en-nz",
  "en-za", "en-in", "en-sg", "en-jm",
]);

interface Candidate {
  id: number;
  word: string;
}

interface Resolved {
  phonetic: string;
  source: "wiktionary" | "cmudict" | "derived" | "composed";
}

// ---------------------------------------------------------------------------
// Wiktionary
// ---------------------------------------------------------------------------

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < value.length; i++) {
    const pair = value.slice(i, i + 2);
    if (pair === "{{" || pair === "[[") {
      depth++;
      current += pair;
      i++;
      continue;
    }
    if (pair === "}}" || pair === "]]") {
      depth--;
      current += pair;
      i++;
      continue;
    }
    if (value[i] === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += value[i];
  }

  parts.push(current);
  return parts;
}

/** Reads a `{{...}}` template starting at `start`, honouring nested braces. */
function readTemplate(text: string, start: number): { params: string[]; end: number } | null {
  let depth = 0;
  let end = -1;

  for (let i = start; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === "{{") {
      depth++;
      i++;
    } else if (pair === "}}") {
      depth--;
      i++;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end === -1) return null;
  return { params: splitTopLevel(text.slice(start + 2, end - 2), "|"), end };
}

function cleanIpa(value: string): string | null {
  let ipa = value.trim();
  ipa = ipa.replace(/\[\[|\]\]/g, "").replace(/\{\{[^}]*\}\}/g, "").trim();
  if (!ipa || ipa.length > 48) return null;

  const delimited = ipa.match(/\/([^/]+)\//);
  if (delimited) return `/${delimited[1].trim()}/`;

  const bracketed = ipa.match(/\[([^\]]+)\]/);
  if (bracketed) return `/${bracketed[1].trim()}/`;

  return null;
}

function parseWiktionaryIpa(wikitext: string): string | null {
  const phonemic: string[] = [];
  const phonetic: string[] = [];
  const templateRe = /\{\{IPA\b/gi;
  let match: RegExpExecArray | null;

  while ((match = templateRe.exec(wikitext)) !== null) {
    const template = readTemplate(wikitext, match.index);
    if (!template) continue;
    templateRe.lastIndex = template.end;

    const [, ...params] = template.params;
    let isEnglish = false;
    const values: string[] = [];

    for (const raw of params) {
      const param = raw.trim();
      if (EN_LANGUAGE_CODES.has(param.toLowerCase())) {
        isEnglish = true;
        continue;
      }
      if (/^lang\s*=\s*en\b/i.test(param)) {
        isEnglish = true;
        continue;
      }
      if (param.startsWith("/") || param.startsWith("[")) values.push(param);
    }

    if (!isEnglish) continue;

    for (const value of values) {
      if (value.startsWith("/")) phonemic.push(value);
      else phonetic.push(value);
    }
  }

  const pool = phonemic.length > 0 ? phonemic : phonetic;
  for (const value of pool) {
    const cleaned = cleanIpa(value);
    if (cleaned) return cleaned;
  }

  return null;
}

async function wiktionaryFetch(
  titles: string[],
  attempt = 0
): Promise<Map<string, string>> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "revisions",
    rvslots: "main",
    rvprop: "content",
    redirects: "1",
    titles: titles.join("|"),
  });

  const response = await fetch(`${WIKTIONARY_API}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });

  if (response.status === 429 || response.status >= 500) {
    if (attempt >= 6) throw new Error(`Wiktionary API error: ${response.status}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1500 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return wiktionaryFetch(titles, attempt + 1);
  }

  if (!response.ok) throw new Error(`Wiktionary API error: ${response.status}`);

  const data = (await response.json()) as {
    query?: {
      pages?: Array<{
        title: string;
        missing?: boolean;
        revisions?: Array<{ slots?: { main?: { content?: string } } }>;
      }>;
      redirects?: Array<{ from: string; to: string }>;
      normalized?: Array<{ from: string; to: string }>;
    };
  };

  const pages = new Map<string, string>();
  for (const page of data.query?.pages ?? []) {
    pages.set(
      page.title.toLowerCase(),
      page.missing ? "" : page.revisions?.[0]?.slots?.main?.content ?? ""
    );
  }

  const renames = new Map<string, string>();
  for (const entry of data.query?.normalized ?? []) {
    renames.set(entry.from.toLowerCase(), entry.to.toLowerCase());
  }
  for (const entry of data.query?.redirects ?? []) {
    renames.set(entry.from.toLowerCase(), entry.to.toLowerCase());
  }

  const result = new Map<string, string>();
  for (const title of titles) {
    let key = title.toLowerCase();
    key = renames.get(key) ?? key;
    result.set(title, pages.get(key) ?? "");
  }

  return result;
}

// ---------------------------------------------------------------------------
// CMUdict -> IPA
// ---------------------------------------------------------------------------

const ARPABET_VOWELS: Record<string, string> = {
  AA: "ɑ", AE: "æ", AH: "ʌ", AO: "ɔ", AW: "aʊ", AY: "aɪ", EH: "ɛ",
  ER: "ɝ", EY: "eɪ", IH: "ɪ", IY: "i", OW: "oʊ", OY: "ɔɪ", UH: "ʊ",
  UW: "u",
};

const ARPABET_CONSONANTS: Record<string, string> = {
  B: "b", CH: "tʃ", D: "d", DH: "ð", F: "f", G: "ɡ", HH: "h", JH: "dʒ",
  K: "k", L: "l", M: "m", N: "n", NG: "ŋ", P: "p", R: "ɹ", S: "s",
  SH: "ʃ", T: "t", TH: "θ", V: "v", W: "w", Y: "j", Z: "z", ZH: "ʒ",
};

/** Onsets that may start an English syllable, used to place stress marks. */
const LEGAL_ONSETS = new Set([
  "", "b", "d", "f", "ɡ", "h", "j", "k", "l", "m", "n", "p", "ɹ", "s",
  "t", "v", "w", "z", "ʃ", "tʃ", "dʒ", "θ", "ð", "ʒ", "ŋ",
  "pl", "pɹ", "pj", "bl", "bɹ", "bj", "tɹ", "tw", "tj", "dɹ", "dw", "dj",
  "kl", "kɹ", "kw", "kj", "ɡl", "ɡɹ", "ɡw", "fj", "vj", "θɹ", "θw", "ðj",
  "sl", "sw", "sp", "st", "sk", "sm", "sn", "sf", "ʃɹ", "hj", "mj", "nj",
  "lj", "spl", "spɹ", "spj", "stɹ", "stj", "skɹ", "skw", "skj",
]);

type Phone =
  | { type: "consonant"; ipa: string }
  | { type: "vowel"; ipa: string; stress: number };

function arpabetToIpa(arpabet: string): string | null {
  const phones: Phone[] = [];

  for (const token of arpabet.trim().split(/\s+/)) {
    const match = token.match(/^([A-Z]+)([0-2])?$/);
    if (!match) continue;

    const [, base, stress] = match;
    if (base in ARPABET_VOWELS) {
      let ipa = ARPABET_VOWELS[base];
      if (base === "AH" && stress === "0") ipa = "ə";
      if (base === "ER") ipa = stress === "0" ? "ɚ" : "ɝ";
      phones.push({ type: "vowel", ipa, stress: stress ? Number(stress) : 0 });
    } else if (base in ARPABET_CONSONANTS) {
      phones.push({ type: "consonant", ipa: ARPABET_CONSONANTS[base] });
    }
  }

  const vowels = phones.filter((phone) => phone.type === "vowel");
  if (vowels.length === 0) return null;

  const pieces = phones.map((phone) => phone.ipa);
  // Monosyllables carry no stress mark in learner dictionaries.
  if (vowels.length === 1) return pieces.join("");

  const insertions: Array<{ at: number; mark: string }> = [];
  let previousVowel = -1;

  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i];
    if (phone.type !== "vowel") continue;

    if (phone.stress === 1) {
      let start = i;
      while (start > previousVowel + 1 && phones[start - 1].type === "consonant") {
        start--;
      }

      const cluster = phones.slice(start, i).map((item) => item.ipa);
      let onsetStart = start;
      // Maximal legal onset: "nfr" -> "fr", "str" -> "str".
      for (let count = cluster.length; count >= 0; count--) {
        const suffix = cluster.slice(cluster.length - count).join("");
        if (LEGAL_ONSETS.has(suffix)) {
          onsetStart = i - count;
          break;
        }
      }

      insertions.push({ at: onsetStart, mark: "ˈ" });
    }

    previousVowel = i;
  }

  // Insert right-to-left so earlier indices stay valid.
  insertions.sort((a, b) => b.at - a.at);
  for (const insertion of insertions) {
    pieces.splice(insertion.at, 0, insertion.mark);
  }

  return pieces.join("");
}

let cmuDict: Map<string, string[]> | null = null;

async function loadCmudict(): Promise<Map<string, string[]>> {
  if (cmuDict) return cmuDict;

  if (!existsSync(CMUDICT_CACHE)) {
    mkdirSync(dirname(CMUDICT_CACHE), { recursive: true });
    console.log(`Downloading CMUdict to ${CMUDICT_CACHE} ...`);
    const response = await fetch(CMUDICT_URL);
    if (!response.ok) {
      throw new Error(`CMUdict download failed: ${response.status}`);
    }
    writeFileSync(CMUDICT_CACHE, await response.text());
  }

  const dict = new Map<string, string[]>();
  for (const line of readFileSync(CMUDICT_CACHE, "utf8").split("\n")) {
    if (!line || line.startsWith(";;;")) continue;
    const match = line.match(/^(\S+?)(?:\(\d+\))?\s+(.+)$/);
    if (!match) continue;
    const word = match[1].toLowerCase();
    if (!dict.has(word)) dict.set(word, match[2].trim().split(/\s+/));
  }

  cmuDict = dict;
  console.log(`CMUdict entries: ${dict.size}`);
  return dict;
}

function cmudictLookup(word: string): string | null {
  if (!cmuDict) return null;
  const candidates = [word.toLowerCase(), word.toLowerCase().replace(/’/g, "'")];
  for (const key of candidates) {
    const phones = cmuDict.get(key);
    if (!phones) continue;
    const ipa = arpabetToIpa(phones.join(" "));
    if (ipa) return `/${ipa}/`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derivation (prefix / suffix / compound)
// ---------------------------------------------------------------------------

const VOICELESS = new Set(["p", "t", "k", "f", "θ", "s", "ʃ", "tʃ"]);
const SIBILANT = new Set(["s", "z", "ʃ", "ʒ", "tʃ", "dʒ"]);
const MULTI_PHONEMES = ["tʃ", "dʒ", "aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ", "ɪə", "eə", "ʊə", "əʊ", "ɚ", "ɝ"];

const PREFIXES = [
  "counter", "inter", "super", "under", "anti", "multi", "semi", "over",
  "post", "fore", "micro", "macro", "hyper", "ultra", "auto", "non", "pre",
  "mis", "dis", "out", "sub", "tri", "un", "re", "co", "de", "bi",
];

type SuffixIpa = string | ((lastPhoneme: string) => string);

interface SuffixCandidate {
  lemma: string;
  suffix: SuffixIpa;
}

function stripSlashes(phonetic: string): string {
  return phonetic.replace(/^\/|\/$/g, "");
}

function lastPhoneme(phonetic: string): string {
  const body = stripSlashes(phonetic).replace(/[ˈˌ.ː\s]/g, "");
  for (const phoneme of MULTI_PHONEMES) {
    if (body.endsWith(phoneme)) return phoneme;
  }
  return body.slice(-1);
}

function pluralSuffix(last: string): string {
  if (SIBILANT.has(last)) return "ɪz";
  return VOICELESS.has(last) ? "s" : "z";
}

function pastSuffix(last: string): string {
  if (last === "t" || last === "d") return "ɪd";
  return VOICELESS.has(last) ? "t" : "d";
}

function withPrimary(phonetic: string): string {
  const body = stripSlashes(phonetic);
  return body.includes("ˈ") ? body : `ˈ${body}`;
}

function withSecondary(phonetic: string): string {
  const body = stripSlashes(phonetic);
  if (body.includes("ˈ")) return body.replace("ˈ", "ˌ");
  return body;
}

function suffixHasVowel(suffix: string): boolean {
  return /[aeiouɑæʌɔəɛɪiʊuɝɚ]/.test(suffix);
}

function wordVariants(stem: string): string[] {
  const variants = [stem];
  if (stem.length > 3 && stem.at(-1) === stem.at(-2)) {
    variants.push(stem.slice(0, -1));
  }
  return variants;
}

function suffixCandidates(word: string): SuffixCandidate[] {
  const w = word.toLowerCase();
  const candidates: SuffixCandidate[] = [];
  const add = (lemma: string, suffix: SuffixIpa) => {
    for (const variant of wordVariants(lemma)) {
      if (variant.length >= 3) candidates.push({ lemma: variant, suffix });
    }
  };

  if (w.endsWith("iest")) add(`${w.slice(0, -4)}y`, "iɪst");
  if (w.endsWith("ier")) add(`${w.slice(0, -3)}y`, "iɚ");
  if (w.endsWith("ing")) {
    const stem = w.slice(0, -3);
    add(stem, "ɪŋ");
    add(`${stem}e`, "ɪŋ");
  }
  if (w.endsWith("ed")) {
    add(w.slice(0, -2), pastSuffix);
    add(w.slice(0, -1), pastSuffix);
  }
  if (w.endsWith("ly")) add(w.slice(0, -2), "li");
  if (w.endsWith("ness")) add(w.slice(0, -4), "nəs");
  if (w.endsWith("ment")) add(w.slice(0, -4), "mənt");
  if (w.endsWith("es")) {
    add(w.slice(0, -2), "ɪz");
    add(w.slice(0, -1), "z");
  }
  if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1), pluralSuffix);
  if (w.endsWith("est")) add(w.slice(0, -3), "ɪst");
  if (w.endsWith("er")) {
    add(w.slice(0, -2), "ɚ");
    add(w.slice(0, -1), "ɚ");
  }

  return candidates;
}

function prefixCandidates(word: string): Array<{ prefix: string; stem: string }> {
  const w = word.toLowerCase();
  return PREFIXES.filter(
    (prefix) => w.startsWith(prefix) && w.length - prefix.length >= 3
  ).map((prefix) => ({ prefix, stem: w.slice(prefix.length) }));
}

function compoundCandidates(word: string): Array<{ left: string; right: string }> {
  const w = word.toLowerCase();
  const candidates: Array<{ left: string; right: string }> = [];
  for (let i = 3; i <= w.length - 3; i++) {
    candidates.push({ left: w.slice(0, i), right: w.slice(i) });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

class Resolver {
  private wiktionaryCache = new Map<string, string | null>();
  private cmuCache = new Map<string, string | null>();
  private deriveCache = new Map<string, Resolved | null>();

  /** Batch-fetches Wiktionary pages and records their IPA in the cache. */
  async prime(words: string[]): Promise<void> {
    const pending = [...new Set(words.map((word) => word.trim()).filter(Boolean))].filter(
      (word) => !this.wiktionaryCache.has(word.toLowerCase())
    );

    for (let i = 0; i < pending.length; i += WIKTIONARY_BATCH_SIZE) {
      const batch = pending.slice(i, i + WIKTIONARY_BATCH_SIZE);
      const pages = await wiktionaryFetch(batch);
      for (const [title, wikitext] of pages) {
        this.wiktionaryCache.set(
          title.toLowerCase(),
          wikitext ? parseWiktionaryIpa(wikitext) : null
        );
      }
      if (i + WIKTIONARY_BATCH_SIZE < pending.length) {
        await new Promise((resolve) => setTimeout(resolve, WIKTIONARY_DELAY_MS));
      }
    }
  }

  private lookupCmudict(word: string): string | null {
    const key = word.toLowerCase();
    if (this.cmuCache.has(key)) return this.cmuCache.get(key) ?? null;
    const value = cmudictLookup(word);
    this.cmuCache.set(key, value);
    return value;
  }

  private lookupExact(word: string): Resolved | null {
    const fromWiktionary = this.wiktionaryCache.get(word.trim().toLowerCase());
    if (fromWiktionary) return { phonetic: fromWiktionary, source: "wiktionary" };

    const fromCmudict = this.lookupCmudict(word);
    if (fromCmudict) return { phonetic: fromCmudict, source: "cmudict" };

    return null;
  }

  private derive(word: string, depth: number): Resolved | null {
    if (depth > 3) return null;
    // Phrases are composed token by token in `resolve`, never as compounds.
    if (/\s/.test(word)) return null;

    const key = word.toLowerCase();
    if (this.deriveCache.has(key)) return this.deriveCache.get(key) ?? null;

    const remember = (result: Resolved | null): Resolved | null => {
      this.deriveCache.set(key, result);
      return result;
    };

    for (const { lemma, suffix } of suffixCandidates(word)) {
      const base = this.resolveDerivable(lemma, depth + 1);
      if (!base) continue;

      const suffixIpa =
        typeof suffix === "string" ? suffix : suffix(lastPhoneme(base.phonetic));
      let body = stripSlashes(base.phonetic);
      if (suffixHasVowel(suffixIpa) && !body.includes("ˈ")) body = `ˈ${body}`;
      return remember({ phonetic: `/${body}${suffixIpa}/`, source: "derived" });
    }

    for (const { prefix, stem } of prefixCandidates(word)) {
      const prefixResult = this.lookupExact(prefix);
      const stemResult = this.resolveDerivable(stem, depth + 1);
      if (!prefixResult || !stemResult) continue;

      return remember({
        phonetic: `/${withSecondary(prefixResult.phonetic)}${withPrimary(stemResult.phonetic)}/`,
        source: "derived",
      });
    }

    for (const { left, right } of compoundCandidates(word)) {
      const leftResult = this.resolveDerivable(left, depth + 1);
      const rightResult = this.resolveDerivable(right, depth + 1);
      if (!leftResult || !rightResult) continue;

      return remember({
        phonetic: `/${withPrimary(leftResult.phonetic)}${withSecondary(rightResult.phonetic)}/`,
        source: "derived",
      });
    }

    return remember(null);
  }

  private resolveDerivable(word: string, depth: number): Resolved | null {
    return this.lookupExact(word) ?? this.derive(word, depth);
  }

  private phraseTokens(word: string): string[] | null {
    const tokens = word.split(/[\s-]+/).filter(Boolean);
    return tokens.length > 1 ? tokens : null;
  }

  /** Tokens that still need a Wiktionary lookup before phrase composition. */
  missingPhraseTokens(words: string[]): string[] {
    const missing: string[] = [];
    for (const word of words) {
      const tokens = this.phraseTokens(word);
      if (!tokens) continue;
      for (const token of tokens) {
        if (!this.wiktionaryCache.has(token.toLowerCase()) && !this.lookupCmudict(token)) {
          missing.push(token);
        }
      }
    }
    return missing;
  }

  resolve(word: string): Resolved | null {
    const tokens = this.phraseTokens(word);
    if (tokens) {
      // A dedicated Wiktionary page (e.g. "look up") beats composition.
      const exact = this.lookupExact(word);
      if (exact) return exact;

      const pieces: string[] = [];
      for (const token of tokens) {
        const resolved = this.resolveDerivable(token, 0);
        if (!resolved) return null;
        pieces.push(stripSlashes(resolved.phonetic));
      }

      return { phonetic: `/${pieces.join(" ")}/`, source: "composed" };
    }

    return this.resolveDerivable(word, 0);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  write: boolean;
  overwrite: boolean;
  limit: number;
  sample: number;
  verbose: boolean;
}

function parseOptions(argv: string[]): Options {
  const numberFlag = (name: string, fallback: number): number => {
    const raw = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (!raw) return fallback;
    const value = Number(raw.split("=")[1]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };

  return {
    write: argv.includes("--write"),
    overwrite: argv.includes("--overwrite"),
    limit: numberFlag("limit", Number.POSITIVE_INFINITY),
    sample: numberFlag("sample", 25),
    verbose: argv.includes("--verbose"),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await initDatabase();
  await loadCmudict();

  const mode = process.env.DB_MODE === "turso" ? "turso" : "local";
  console.log(
    `Database: ${mode}${mode === "local" ? ` (${process.env.DB_PATH ?? "./data/vocleap.db"})` : ""}`
  );

  const rows = await db.prepare("SELECT id, word, phonetic FROM words ORDER BY id").all();
  const filled = new Set(
    rows
      .filter((row) => String(row.phonetic ?? "").trim() !== "")
      .map((row) => Number(row.id))
  );

  let candidates: Candidate[] = rows
    .map((row) => ({ id: Number(row.id), word: String(row.word ?? "") }))
    .filter((candidate) => options.overwrite || !filled.has(candidate.id));

  const artefacts = candidates.filter((candidate) => ARTEFACT_RE.test(candidate.word));
  candidates = candidates.filter((candidate) => !ARTEFACT_RE.test(candidate.word));
  if (Number.isFinite(options.limit)) candidates = candidates.slice(0, options.limit);

  console.log(`Candidates: ${candidates.length}`);
  if (artefacts.length > 0) {
    console.log(`Skipped ${artefacts.length} import artefacts (e.g. ${artefacts[0].word})`);
  }

  const resolver = new Resolver();
  console.log(`Fetching Wiktionary (${candidates.length} words, batches of ${WIKTIONARY_BATCH_SIZE}) ...`);
  await resolver.prime(candidates.map((candidate) => candidate.word));

  const missingTokens = resolver.missingPhraseTokens(
    candidates.map((candidate) => candidate.word)
  );
  if (missingTokens.length > 0) {
    console.log(`Fetching Wiktionary for ${missingTokens.length} phrase tokens ...`);
    await resolver.prime(missingTokens);
  }

  const resolved: Array<{ candidate: Candidate; result: Resolved }> = [];
  const failed: Candidate[] = [];

  for (const candidate of candidates) {
    const result = resolver.resolve(candidate.word);
    if (result) resolved.push({ candidate, result });
    else failed.push(candidate);
  }

  const bySource = { wiktionary: 0, cmudict: 0, derived: 0, composed: 0 };
  for (const { result } of resolved) bySource[result.source] += 1;

  console.log(`\nResolved: ${resolved.length}`);
  console.log(
    `  wiktionary ${bySource.wiktionary} | cmudict ${bySource.cmudict} | derived ${bySource.derived} | composed ${bySource.composed}`
  );
  console.log(`Unresolved: ${failed.length}`);

  console.log("\nProposed values:");
  for (const { candidate, result } of resolved.slice(0, options.sample)) {
    console.log(`  ${candidate.word.padEnd(28)} ${result.phonetic}  (${result.source})`);
  }

  if (failed.length > 0) {
    const shown = options.verbose ? failed : failed.slice(0, 40);
    console.log(`\nUnresolved words${options.verbose ? "" : " (first 40, use --verbose for all)"}:`);
    for (const candidate of shown) console.log(`  ${candidate.word}`);
  }

  if (!options.write) {
    console.log("\nDry run — nothing written. Re-run with --write to persist.");
    return;
  }

  const update = db.prepare("UPDATE words SET phonetic = ? WHERE id = ?");
  let written = 0;
  const chunkSize = 8;
  for (let i = 0; i < resolved.length; i += chunkSize) {
    const chunk = resolved.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(({ candidate, result }) => update.run(result.phonetic, candidate.id))
    );
    written += chunk.length;
    if (written % 200 === 0) process.stdout.write(`\rWritten ${written}/${resolved.length}`);
  }
  process.stdout.write(`\rWritten ${written}/${resolved.length}\n`);
  console.log("Done.");
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
