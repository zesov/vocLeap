/**
 * Dictionary phonetics come in two shapes: bare transcriptions from Google
 * Translate ("həˈloʊ") and already-delimited/Wiktionary strings that include
 * slashes or labels ("/ˈbleɪtənt/"). Only wrap the bare form so we never
 * double the slashes.
 */
export function formatPhonetic(phonetic: string): string {
  const trimmed = phonetic.trim();
  if (!trimmed) return "";
  return trimmed.includes("/") ? trimmed : `/${trimmed}/`;
}
