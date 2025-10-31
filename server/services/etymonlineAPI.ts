import NodeCache from 'node-cache';
import aiService from './aiService';

const cache = new NodeCache({ stdTTL: 7200 });

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
    origin?: string;
    sharedRoot?: string;
    isFromCrossReference?: boolean;
    isFromShortenedDatabase?: boolean;
  };
}

interface EtymologyData {
  connections: EtymologyConnection[];
  crossReferences?: Array<{
    sharedRoot: string;
    cognateWords: any[];
    totalCognates: number;
  }>;
}

interface WordEntry {
  word: string;
  language: string;
  etymologicalForm: string;
  etymologicalLanguage: string;
  relationshipType: string;
  confidence: number;
  notes: string;
  sharedRoot: string;
}

class EtymonlineAPI {
  private baseURL: string;
  private etymologyDatabase: Map<string, WordEntry[]>;
  private processedWords: Set<string>;
  private shortenedFormsDatabase: Map<string, Array<{ word: string; confidence: number; notes: string }>>;

  constructor() {
    this.baseURL = 'https://www.etymonline.com/word';
    this.etymologyDatabase = new Map();
    this.processedWords = new Set();
    this.shortenedFormsDatabase = new Map();
  }

  async fetchEtymologyData(word: string, language: string = 'en'): Promise<EtymologyData | null> {
    const cacheKey = `etymonline_${word}_${language}`;
    const cached = cache.get<EtymologyData>(cacheKey);
    if (cached) {
      console.log(`[ETYMONLINE] Cache hit for "${word}"`);
      return cached;
    }

    console.log(`[ETYMONLINE] Fetching etymology data for "${word}"`);

    try {
      let url: string;
      if (word.startsWith('*')) {
        url = `${this.baseURL}/${encodeURIComponent(word)}`;
      } else {
        url = `${this.baseURL}/${word}`;
      }

      console.log(`[ETYMONLINE] → Scraping page: ${url}`);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      console.log(`[ETYMONLINE] Response status: ${response.status}`);

      if (!response.ok) {
        console.log(`[ETYMONLINE] Failed to fetch: ${response.status} ${response.statusText}`);
        return null;
      }

      const html = await response.text();
      console.log(`[ETYMONLINE] Received HTML (${html.length} bytes)`);

      const etymologyData = await this.parseEtymologyWithAI(html, word, language, url);
      console.log(`[ETYMONLINE] AI parsing completed, connections: ${etymologyData?.connections?.length || 0}`);

      this.updateEtymologyDatabase(word, etymologyData);

      const enhancedData = this.enhanceWithCrossReferences(etymologyData, word);
      console.log(`[ETYMONLINE] Enhanced data, total connections: ${enhancedData?.connections?.length || 0}`);

      cache.set(cacheKey, enhancedData);
      return enhancedData;

    } catch (error) {
      console.error(`[ETYMONLINE ERROR] Failed to fetch data for "${word}":`, (error as Error).message);
      console.error(`[ETYMONLINE ERROR] Stack:`, (error as Error).stack);
      return null;
    }
  }

  private async parseEtymologyWithAI(html: string, word: string, language: string, url: string): Promise<EtymologyData> {
    console.log(`[AI] Starting AI extraction for "${word}" from ${url}`);

    try {
      const isAvailable = aiService.isAvailable();

      if (!isAvailable) {
        console.warn(`[AI] No API key configured. Please set AI_API_KEY in .env to enable AI-powered etymology extraction.`);
        return { connections: [] };
      }

      const connections = await aiService.extractEtymology(html, word, language);

      console.log(`[AI] ✓ Completed extraction from ${url}`);
      return { connections };

    } catch (error) {
      console.error(`[AI ERROR] Failed to parse etymology for "${word}":`, (error as Error).message);
      console.error(`[AI ERROR] Stack:`, (error as Error).stack);
      return { connections: [] };
    }
  }

  private updateEtymologyDatabase(sourceWord: string, etymologyData: EtymologyData): void {
    if (!etymologyData || !etymologyData.connections) return;

    this.processedWords.add(sourceWord);

    for (const connection of etymologyData.connections) {
      const { word: etimWord, relationship } = connection;

      if (relationship.type === 'shortened_from') {
        if (!this.shortenedFormsDatabase.has(etimWord.text.toLowerCase())) {
          this.shortenedFormsDatabase.set(etimWord.text.toLowerCase(), []);
        }
        const shortenedForms = this.shortenedFormsDatabase.get(etimWord.text.toLowerCase());
        if (shortenedForms && !shortenedForms.some(form => form.word === sourceWord)) {
          shortenedForms.push({
            word: sourceWord,
            confidence: relationship.confidence,
            notes: relationship.notes
          });
        }
      }

      const sharedRoot = relationship.sharedRoot || relationship.origin || etimWord.text;
      if (!etimWord || !etimWord.text || !sharedRoot) continue;

      const etymologyKey = this.normalizeEtymologyKey(sharedRoot);

      if (!this.etymologyDatabase.has(etymologyKey)) {
        this.etymologyDatabase.set(etymologyKey, []);
      }

      const wordEntry: WordEntry = {
        word: sourceWord,
        language: 'en',
        etymologicalForm: etimWord.text,
        etymologicalLanguage: etimWord.language,
        relationshipType: relationship.type,
        confidence: relationship.confidence,
        notes: relationship.notes,
        sharedRoot: sharedRoot
      };

      const existingEntries = this.etymologyDatabase.get(etymologyKey);
      if (existingEntries && !existingEntries.some(entry => entry.word === sourceWord)) {
        existingEntries.push(wordEntry);
      }
    }
  }

  private normalizeEtymologyKey(etymologyString: string): string {
    if (!etymologyString) return '';

    let normalized = etymologyString.trim();

    const pieRootMatch = normalized.match(/\*([a-zA-Z₀-₉ʰₑʷβɟḱĝʷʲʼ-]+)/);
    if (pieRootMatch) {
      return '*' + pieRootMatch[1].toLowerCase();
    }

    normalized = normalized
      .replace(/^(Proto-Indo-European|PIE)\s+/i, '')
      .replace(/^(Proto-[A-Za-z-]+|Old [A-Za-z]+|Middle [A-Za-z]+|Ancient [A-Za-z]+|[A-Za-z]+)\s+/i, '')
      .trim()
      .toLowerCase();

    if (normalized.startsWith('*')) {
      return normalized;
    }

    normalized = normalized.replace(/[.,;:!?]+$/, '');

    return normalized;
  }

  private enhanceWithCrossReferences(etymologyData: EtymologyData, sourceWord: string): EtymologyData {
    if (!etymologyData || !etymologyData.connections) return etymologyData;

    const enhanced: EtymologyData = { ...etymologyData };
    enhanced.crossReferences = [];
    const addedConnections: EtymologyConnection[] = [];

    for (const connection of etymologyData.connections) {
      const { relationship } = connection;

      const sharedRoot = relationship.sharedRoot || relationship.origin;
      if (!sharedRoot) continue;

      const etymologyKey = this.normalizeEtymologyKey(sharedRoot);
      const relatedWords = this.etymologyDatabase.get(etymologyKey);

      if (relatedWords && relatedWords.length > 1) {
        const potentialCognates = relatedWords
          .filter(entry => entry.word !== sourceWord)
          .map(entry => ({
            word: entry.word,
            language: entry.language,
            etymologicalForm: entry.etymologicalForm,
            relationshipType: 'cognate_cross_reference',
            sharedRoot: sharedRoot,
            confidence: Math.min(0.75, entry.confidence),
            notes: `Shares etymology ${sharedRoot} with ${sourceWord}`
          }));

        const validCognates = potentialCognates.filter(cognate => {
          if (this.areSemanticallySuspicious(cognate.word, sourceWord)) {
            return false;
          }

          if (cognate.confidence < 0.65) {
            return false;
          }

          return true;
        });

        if (validCognates.length > 0) {
          enhanced.crossReferences.push({
            sharedRoot: sharedRoot,
            cognateWords: validCognates,
            totalCognates: validCognates.length
          });

          const topCognates = validCognates
            .filter(cognate => cognate.confidence > 0.75)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 2);

          for (const cognate of topCognates) {
            if (this.isValidCrossReferenceConnection(sourceWord, cognate.word, sharedRoot)) {
              const bidirectionalConnection: EtymologyConnection = {
                word: {
                  id: this.generateId(),
                  text: cognate.word,
                  language: cognate.language,
                  partOfSpeech: 'cognate',
                  definition: `Related to "${sourceWord}" through shared root "${sharedRoot}"`
                },
                relationship: {
                  type: 'etymological_cognate',
                  confidence: Math.min(cognate.confidence * 0.9, 0.85),
                  notes: cognate.notes,
                  origin: sharedRoot,
                  sharedRoot: sharedRoot,
                  isFromCrossReference: true
                }
              };
              addedConnections.push(bidirectionalConnection);
            }
          }
        }
      }
    }

    if (this.shortenedFormsDatabase.has(sourceWord.toLowerCase())) {
      const shortenedForms = this.shortenedFormsDatabase.get(sourceWord.toLowerCase());

      if (shortenedForms) {
        for (const shortenedForm of shortenedForms) {
          if (shortenedForm.confidence > 0.8 && !this.areSemanticallySuspicious(shortenedForm.word, sourceWord)) {
            const reverseConnection: EtymologyConnection = {
              word: {
                id: this.generateId(),
                text: shortenedForm.word,
                language: 'en',
                partOfSpeech: 'shortened_form',
                definition: `Shortened form of "${sourceWord}"`
              },
              relationship: {
                type: 'shortened_to',
                confidence: Math.min(shortenedForm.confidence, 0.9),
                notes: `"${shortenedForm.word}" is a shortened form of "${sourceWord}"`,
                origin: `Shortened form: ${shortenedForm.word}`,
                sharedRoot: sourceWord,
                isFromShortenedDatabase: true
              }
            };
            addedConnections.push(reverseConnection);
          }
        }
      }
    }

    enhanced.connections = [...(enhanced.connections || []), ...addedConnections];

    return enhanced;
  }

  private areSemanticallySuspicious(word: string, sourceWord: string): boolean {
    const wordLower = word.toLowerCase();
    const sourceLower = sourceWord.toLowerCase();

    const basicElements = ['fire', 'water', 'earth', 'air', 'wind'];
    const colors = ['red', 'blue', 'green', 'yellow', 'black', 'white'];
    const numbers = ['one', 'two', 'three', 'four', 'five'];

    const wordIsElement = basicElements.includes(wordLower);
    const sourceIsElement = basicElements.includes(sourceLower);
    const wordIsColor = colors.includes(wordLower);
    const sourceIsColor = colors.includes(sourceLower);
    const wordIsNumber = numbers.includes(wordLower);
    const sourceIsNumber = numbers.includes(sourceLower);

    if ((wordIsElement && sourceIsColor) || (wordIsColor && sourceIsElement)) {
      return true;
    }
    if ((wordIsElement && sourceIsNumber) || (wordIsNumber && sourceIsElement)) {
      return true;
    }

    const suspiciousPairs = [
      ['water', 'fire'], ['fire', 'water'],
      ['water', 'punjab'], ['punjab', 'water'],
      ['test', 'forest'], ['forest', 'test']
    ];

    if (wordLower.startsWith('*') || sourceLower.startsWith('*')) {
      return false;
    }

    for (const [susp1, susp2] of suspiciousPairs) {
      if ((wordLower === susp1 && sourceLower === susp2) || (wordLower === susp2 && sourceLower === susp1)) {
        return true;
      }
    }

    return false;
  }

  private isValidCrossReferenceConnection(sourceWord: string, targetWord: string, sharedRoot: string): boolean {
    if (!sourceWord || !targetWord || !sharedRoot) {
      return false;
    }

    if (sourceWord.toLowerCase() === targetWord.toLowerCase()) {
      return false;
    }

    if (this.areSemanticallySuspicious(sourceWord, targetWord)) {
      return false;
    }

    const cleanRoot = this.normalizeEtymologyKey(sharedRoot);
    if (cleanRoot.length < 3) {
      return false;
    }

    const genericRoots = ['*er', '*ed', '*in', '*on', '*an', '*el', 'the', 'and', 'from'];
    if (genericRoots.includes(cleanRoot.toLowerCase())) {
      return false;
    }

    return true;
  }

  async findEtymologicalCognates(word: string, minConfidence: number = 0.7): Promise<any[]> {
    const wordData = await this.fetchEtymologyData(word);
    if (!wordData || !wordData.connections) return [];

    const cognateGroups = [];

    for (const connection of wordData.connections) {
      const { relationship } = connection;

      if (!relationship.sharedRoot || relationship.confidence < minConfidence) continue;

      const etymologyKey = this.normalizeEtymologyKey(relationship.sharedRoot);
      const relatedWords = this.etymologyDatabase.get(etymologyKey);

      if (relatedWords && relatedWords.length > 1) {
        const cognates = relatedWords
          .filter(entry => entry.word !== word && entry.confidence >= minConfidence)
          .sort((a, b) => b.confidence - a.confidence);

        if (cognates.length > 0) {
          cognateGroups.push({
            sharedRoot: relationship.sharedRoot,
            etymologyKey: etymologyKey,
            cognates: cognates,
            sourceConnection: relationship
          });
        }
      }
    }

    return cognateGroups;
  }

  getEtymologyDatabaseStats(): any {
    const totalEtymologies = this.etymologyDatabase.size;
    const totalWords = this.processedWords.size;
    const cognateGroups = Array.from(this.etymologyDatabase.entries())
      .filter(([key, words]) => words.length > 1)
      .length;

    return {
      totalEtymologicalOrigins: totalEtymologies,
      totalProcessedWords: totalWords,
      cognateGroups: cognateGroups,
      averageWordsPerOrigin: totalWords / Math.max(1, totalEtymologies)
    };
  }

  clearAllCaches(): void {
    cache.flushAll();
    this.etymologyDatabase.clear();
    this.processedWords.clear();
    if (this.shortenedFormsDatabase) {
      this.shortenedFormsDatabase.clear();
    }
  }

  clearWordCache(word: string, language: string = 'en'): void {
    const cacheKey = `etymonline_${word}_${language}`;
    cache.del(cacheKey);
  }

  private generateId(): string {
    return 'w_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  }
}

export default new EtymonlineAPI();
