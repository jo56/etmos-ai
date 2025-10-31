import OpenAI from 'openai';

interface EtymologyConnection {
  word: {
    id: string;
    text: string;
    language: string;
    partOfSpeech: string;
    definition: string;
  };
  relationship: {
    type: string;
    confidence: number;
    notes: string;
    origin: string;
    sharedRoot: string;
    extractedByAI: boolean;
  };
}

interface AIExtractionResult {
  word: string;
  language: string;
  relationshipType: string;
  confidence: number;
  notes?: string;
  partOfSpeech?: string;
  definition?: string;
  sharedRoot?: string;
}

class AIService {
  private provider: string;
  private apiKey: string | undefined;
  private model: string;
  private client: OpenAI | null = null;

  constructor() {
    this.provider = process.env.AI_PROVIDER || 'openai';
    this.apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
    this.model = process.env.AI_MODEL || 'gpt-4o-mini';

    if (!this.apiKey) {
      console.warn('WARNING: No AI API key configured. AI-powered etymology extraction will fail.');
      console.warn('Please set AI_API_KEY or OPENAI_API_KEY in your .env file');
    }

    this.initializeClient();
  }

  private initializeClient(): void {
    if (this.provider === 'openai' && this.apiKey) {
      this.client = new OpenAI({
        apiKey: this.apiKey
      });
      console.log(`AI Service initialized with provider: ${this.provider}, model: ${this.model}`);
    } else if (this.apiKey) {
      console.log(`AI Service initialized with provider: ${this.provider}`);
    }
  }

  async extractEtymology(htmlContent: string, sourceWord: string, language: string = 'en'): Promise<EtymologyConnection[]> {
    if (!this.apiKey) {
      throw new Error('AI API key not configured. Cannot perform extraction.');
    }

    console.log(`[AI] Starting two-step extraction for "${sourceWord}"...`);
    const startTime = Date.now();

    try {
      const cleanedHTML = this.cleanHTML(htmlContent);
      console.log(`[AI] Step 1: Using AI to identify the specific entry for "${sourceWord}" from ${cleanedHTML.length} chars of text...`);

      const specificEntry = await this.extractSpecificEntryWithAI(cleanedHTML, sourceWord);

      if (!specificEntry || specificEntry.length < 10) {
        console.log(`[AI] ⚠ AI extracted entry too short (${specificEntry.length} chars), may not have found correct entry`);
        throw new Error(`Could not extract etymology entry for "${sourceWord}"`);
      }

      console.log(`[AI] Step 1 complete: Extracted specific entry (${specificEntry.length} chars)`);
      console.log(`[AI] Entry preview: ${specificEntry.substring(0, 200)}...`);

      console.log(`[AI] Step 2: Extracting etymological relationships from the entry...`);
      const prompt = this.buildExtractionPrompt(specificEntry, sourceWord, language);

      const response = await this.callAI(prompt);

      const elapsed = Date.now() - startTime;
      console.log(`[AI] Step 2 complete: Response received in ${elapsed}ms total`);

      const connections = this.parseAIResponse(response, sourceWord);

      console.log(`[AI] ✓ Extracted ${connections.length} connections for "${sourceWord}" (${elapsed}ms)`);
      return connections;

    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[AI] ✗ Extraction failed for "${sourceWord}" after ${elapsed}ms:`, (error as Error).message);
      throw error;
    }
  }

  private async extractSpecificEntryWithAI(cleanedText: string, searchedWord: string): Promise<string> {
    const prompt = `You are analyzing text from etymonline.com that may contain multiple dictionary entries for related word forms.

SEARCHED WORD: "${searchedWord}"

FULL TEXT FROM PAGE:
${cleanedText}

TASK:
Identify and extract ONLY the dictionary entry text that corresponds to the word "${searchedWord}".

CONTEXT:
Etymology websites often have multiple entries on one page. For example, a page for "water" might have:
- water(n.1) - the noun entry
- water(v.) - the verb entry
- water(n.2) - a secondary noun entry with different meaning

You need to find the PRIMARY entry for "${searchedWord}" (usually marked as (n.1) or just (n.) or (v.) for verbs).

INSTRUCTIONS:
1. Look for the entry that starts with "${searchedWord}" followed by a part-of-speech marker like (n.1), (n.), (v.), (adj.)
2. Extract ALL the text that belongs to that specific entry
3. STOP when you reach the next entry (which will start with a new word form like "${searchedWord}(v.)" or another word)
4. Do NOT include text from other entries
5. If there are multiple entries for "${searchedWord}", prefer the primary one (n.1 over v., n. over adj.)

OUTPUT FORMAT:
Return ONLY the extracted entry text, with no additional commentary or explanation.
Do not say "Here is the entry" or add any prefix/suffix.
Just return the raw entry text.

Example input text:
"water(n.1) Old English wæter, from Proto-Germanic *watr-... water(v.) Middle English watren..."

Example output:
"water(n.1) Old English wæter, from Proto-Germanic *watr-..."

Now extract the entry for "${searchedWord}":`;

    try {
      const response = await this.callAI(prompt, false);
      return response.trim();
    } catch (error) {
      console.error(`[AI] Error in extractSpecificEntryWithAI:`, (error as Error).message);
      throw error;
    }
  }

  private cleanHTML(html: string): string {
    if (!html) return '';

    let text = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec)))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n\n+/g, '\n\n')
      .trim();

    return text;
  }

  private buildExtractionPrompt(cleanedText: string, sourceWord: string, language: string): string {
    return `You are an expert etymologist analyzing a SPECIFIC etymology entry from etymonline.com.

SOURCE WORD: "${sourceWord}" (${language})

ETYMOLOGY ENTRY TEXT (for "${sourceWord}" ONLY):
${cleanedText}

IMPORTANT CONTEXT:
This text is the etymology entry SPECIFICALLY for the word "${sourceWord}".
It should NOT contain entries for other unrelated words.
Extract ONLY the etymological relationships mentioned in THIS specific entry.

TASK: Extract ALL etymologically related words from this entry. For each related word, identify:
1. The word/form itself (preserve asterisks * for reconstructed forms)
2. The language it comes from
3. The type of relationship (etymology, cognate, derivative, borrowing, etc.)
4. A confidence score (0.0 to 1.0)
5. Brief notes explaining the relationship

IMPORTANT RULES:
- Include PIE (Proto-Indo-European) roots (words with *)
- Include proto-language forms (Proto-Germanic, etc.)
- Include ancient language forms (Old English, Latin, Greek, Sanskrit, etc.)
- Include ALL cognates and related forms across different languages
- Include ALL derivatives that share the same etymological root
- When etymonline lists words that the PIE root "forms all or part of", these are derivatives - extract ALL of them with relationshipType "pie_derivative"
- When etymonline lists words that the root "is the source of" or cognates in other languages, extract ALL of them
- DO NOT include the source word "${sourceWord}" itself
- DO NOT include unrelated words that just happen to be mentioned in examples or cultural context
- Focus on words that have a direct etymological connection through shared roots, ancestry, or cognate relationships

EXAMPLES OF WHAT TO EXTRACT:
- Direct ancestors: "Old English wæter" → extract "wæter" (Old English, etymology)
- Proto-forms: "from Proto-Germanic *watr-" → extract "*watr-" (Proto-Germanic, etymology)
- PIE roots: "from PIE *wed-" → extract "*wed-" (Proto-Indo-European, etymology)
- Cognates in other languages: extract with relationshipType "cognate"
- Derivatives from PIE roots: when the entry lists words the root forms (like "abound, hydra, water, winter"), extract each as "pie_derivative"
- Related forms across language families that share the same root

EXAMPLES OF WHAT NOT TO EXTRACT:
- The source word itself
- Modern compound words formed with the source word (unless they represent a distinct etymological development)
- Unrelated words mentioned only in usage examples or cultural context
- Words that merely sound similar but have no etymological connection

OUTPUT FORMAT (JSON array):
[
  {
    "word": "wæter",
    "language": "Old English",
    "relationshipType": "etymology",
    "confidence": 0.95,
    "notes": "Direct ancestor of modern English 'water'"
  },
  {
    "word": "*watr-",
    "language": "Proto-Germanic",
    "relationshipType": "etymology",
    "confidence": 0.92,
    "notes": "Proto-Germanic root form"
  },
  {
    "word": "watar",
    "language": "Old Saxon",
    "relationshipType": "cognate",
    "confidence": 0.88,
    "notes": "Germanic cognate from the same Proto-Germanic root"
  }
]

Extract the etymological relationships now:`;
  }

  private async callAI(prompt: string, jsonMode: boolean = true): Promise<string> {
    if (this.provider === 'openai') {
      return await this.callOpenAI(prompt, jsonMode);
    } else {
      throw new Error(`Unsupported AI provider: ${this.provider}`);
    }
  }

  private async callOpenAI(prompt: string, jsonMode: boolean = true): Promise<string> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    try {
      const systemMessage = jsonMode
        ? 'You are an expert etymologist. Extract etymological relationships from text and return valid JSON only, with no additional commentary.'
        : 'You are an expert etymologist. Follow the instructions precisely and return only what is requested.';

      const options: any = {
        model: this.model,
        messages: [
          {
            role: 'system',
            content: systemMessage
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 10000
      };

      if (jsonMode) {
        options.response_format = { type: "json_object" };
      }

      const completion = await this.client.chat.completions.create(options);
      const content = completion.choices[0].message.content;
      return content || '';

    } catch (error) {
      console.error('OpenAI API error:', (error as Error).message);
      throw new Error(`OpenAI API call failed: ${(error as Error).message}`);
    }
  }

  private parseAIResponse(response: string, sourceWord: string): EtymologyConnection[] {
    try {
      let parsed: any;

      if (typeof response === 'string') {
        parsed = JSON.parse(response);

        if (parsed.relationships) {
          parsed = parsed.relationships;
        } else if (parsed.words) {
          parsed = parsed.words;
        } else if (parsed.connections) {
          parsed = parsed.connections;
        } else if (!Array.isArray(parsed)) {
          const firstArrayValue = Object.values(parsed).find(v => Array.isArray(v));
          if (firstArrayValue) {
            parsed = firstArrayValue;
          } else {
            throw new Error('Response is not an array and contains no array values');
          }
        }
      } else {
        parsed = response;
      }

      if (!Array.isArray(parsed)) {
        console.error('[AI] Response is not an array:', response);
        return [];
      }

      console.log(`[AI] Parsing ${parsed.length} items from response...`);

      const connections: EtymologyConnection[] = [];
      const extractedWords: string[] = [];
      let skipped = 0;

      for (const item of parsed as AIExtractionResult[]) {
        if (!item.word || !item.language) {
          skipped++;
          continue;
        }

        if (item.word.toLowerCase() === sourceWord.toLowerCase()) {
          skipped++;
          continue;
        }

        const languageCode = this.mapLanguageNameToCode(item.language);

        const connection: EtymologyConnection = {
          word: {
            id: this.generateId(),
            text: item.word.trim(),
            language: languageCode,
            partOfSpeech: item.partOfSpeech || 'unknown',
            definition: item.definition || `${item.language} origin of "${sourceWord}"`
          },
          relationship: {
            type: this.normalizeRelationshipType(item.relationshipType),
            confidence: Math.min(Math.max(item.confidence || 0.7, 0.0), 1.0),
            notes: item.notes || `Extracted by AI from etymonline`,
            origin: item.language + ' ' + item.word,
            sharedRoot: item.sharedRoot || item.word,
            extractedByAI: true
          }
        };

        connections.push(connection);
        extractedWords.push(`"${item.word}" (${item.language})`);
      }

      if (skipped > 0) {
        console.log(`[AI] Skipped ${skipped} invalid/duplicate items`);
      }

      if (extractedWords.length > 0) {
        console.log(`[AI] ✓ Extracted words: ${extractedWords.join(', ')}`);
      }

      return connections;

    } catch (error) {
      console.error('[AI] Failed to parse response:', (error as Error).message);
      console.error('[AI] Raw response:', response);
      return [];
    }
  }

  private mapLanguageNameToCode(languageName: string): string {
    const normalized = (languageName || '').toLowerCase().trim();

    const languageMap: { [key: string]: string } = {
      'old french': 'fro',
      'middle french': 'frm',
      'french': 'fr',
      'latin': 'la',
      'old english': 'ang',
      'middle english': 'enm',
      'english': 'en',
      'greek': 'grc',
      'ancient greek': 'grc',
      'german': 'de',
      'old german': 'goh',
      'old high german': 'goh',
      'middle high german': 'gmh',
      'proto-germanic': 'gem-pro',
      'germanic': 'gem',
      'italian': 'it',
      'spanish': 'es',
      'portuguese': 'pt',
      'dutch': 'nl',
      'middle dutch': 'dum',
      'old dutch': 'odt',
      'old frisian': 'ofs',
      'frisian': 'fy',
      'west frisian': 'fy',
      'old saxon': 'osx',
      'saxon': 'nds',
      'old norse': 'non',
      'norse': 'non',
      'icelandic': 'is',
      'gothic': 'got',
      'proto-indo-european': 'ine-pro',
      'indo-european': 'ine',
      'pie': 'ine-pro',
      'sanskrit': 'sa',
      'hebrew': 'he',
      'arabic': 'ar',
      'slavonic': 'cu',
      'old church slavonic': 'cu',
      'russian': 'ru',
      'polish': 'pl',
      'czech': 'cs',
      'lithuanian': 'lt',
      'latvian': 'lv',
      'welsh': 'cy',
      'irish': 'ga',
      'old irish': 'sga',
      'scottish gaelic': 'gd',
      'breton': 'br'
    };

    const code = languageMap[normalized];
    if (code) {
      return code;
    }

    if (normalized.startsWith('proto-')) {
      return 'proto';
    }

    return normalized.substring(0, 2);
  }

  private normalizeRelationshipType(type: string): string {
    const normalized = (type || '').toLowerCase().trim();

    const typeMap: { [key: string]: string } = {
      'etymology': 'etymology',
      'etymological': 'etymology',
      'ancestor': 'etymology',
      'cognate': 'cognate',
      'related': 'cognate',
      'derivative': 'derivative',
      'derived': 'derivative',
      'borrowing': 'borrowing',
      'borrowed': 'borrowing',
      'loan': 'borrowing',
      'compound': 'compound',
      'pie_derivative': 'pie_derivative',
      'pie derivative': 'pie_derivative',
      'pie root': 'etymology'
    };

    return typeMap[normalized] || 'etymology';
  }

  private generateId(): string {
    return 'w_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }
}

export default new AIService();
