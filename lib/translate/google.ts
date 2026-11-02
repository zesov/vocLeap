export interface TranslationResult {
  word: string;
  translation: string;
  definitions: Array<{
    partOfSpeech: string;
    definition: string;
    examples: string[];
  }>;
  phonetic?: string;
  audioUrl?: string;
  sourceLanguage: string;
  targetLanguage: string;
}

const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";

export async function translateWord(
  word: string,
  sourceLang: string = "en",
  targetLang: string = "zh-CN"
): Promise<TranslationResult | null> {
  try {
    const params = new URLSearchParams({
      client: "web",
      sl: sourceLang,
      tl: targetLang,
      dt: "t,bd,ex,rw",
      q: word,
    });

    const response = await fetch(`${GOOGLE_TRANSLATE_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`Translation API error: ${response.status}`);
    }

    const data = await response.json();

    const translation = data[0]?.[0]?.[0] || "";
    const definitionsData = data[1] || [];
    const phonetic = data[0]?.[0]?.[3] || "";

    const definitions = definitionsData.map((def: any) => ({
      partOfSpeech: def[0] || "",
      definition: def[1]?.[0]?.[0] || "",
      examples: def[1]?.map((ex: any) => ex[0]) || [],
    }));

    const audioUrl = "";

    return {
      word,
      translation,
      definitions: definitions.filter((d: any) => d.definition),
      phonetic,
      audioUrl,
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
    };
  } catch (error) {
    console.error("Translation error:", error);
    return null;
  }
}

export async function synthesizeSpeech(
  text: string,
  languageCode: string = "en-US",
  name: string = "en-US-Wavenet-F"
): Promise<{ audioDataUrl: string } | null> {
  try {
    const { TextToSpeechClient } = require("@google-cloud/text-to-speech");

    const client = new TextToSpeechClient();

    const request = {
      input: { text },
      voice: {
        languageCode,
        name,
      },
      audioConfig: {
        audioEncoding: "MP3",
      },
    };

    const [response] = await client.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error("No audio content returned");
    }

    const base64Audio = Buffer.from(response.audioContent, "binary").toString("base64");
    const audioDataUrl = `data:audio/mp3;base64,${base64Audio}`;

    return { audioDataUrl };
  } catch (error) {
    console.error("TTS synthesis error:", error);
    return null;
  }
}

export async function getSupportedLanguages(): Promise<Array<{ code: string; name: string }>> {
  return [
    { code: "en", name: "English" },
    { code: "zh-CN", name: "Chinese (Simplified)" },
    { code: "zh-TW", name: "Chinese (Traditional)" },
    { code: "ja", name: "Japanese" },
    { code: "ko", name: "Korean" },
    { code: "fr", name: "French" },
    { code: "de", name: "German" },
    { code: "es", name: "Spanish" },
    { code: "ru", name: "Russian" },
  ];
}