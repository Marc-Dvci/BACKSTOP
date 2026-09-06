/**
 * The probe battery.
 *
 * A cell is one task in one language. Each probe asks a question whose answer is a single
 * symbol from the cell's committed alphabet, and the endpoint's distribution over those
 * symbols is what the audit compares against the attested envelope. Single-token answer
 * distributions carry enough signal to separate serving configurations at a cost of one
 * output token per probe.
 *
 * Three properties of the design come straight from the recognition boundary in the threat
 * model, and each is a shipped mitigation rather than a note:
 *
 *   randomised surface form   paraphrase templates, varied languages, ordering and formatting
 *   no max_tokens = 1 tell    a longer completion is requested and the decisive token extracted
 *   plausible task framing    the probe sits inside a request an ordinary caller would send
 *
 * The corpus is committed by Merkle root at issuance and revealed only after the round that
 * used it seals, so the probes a provider could learn are always already spent.
 */

import { Prng } from "./prng.js";
import { keccakString, type Hex } from "./hash.js";

export type Language = "en" | "fr" | "es" | "zh";

export interface Task {
  id: string;
  /** The committed answer alphabet for this task. */
  alphabet: string[];
  /** Paraphrase templates per language. */
  templates: Record<Language, string[]>;
}

export const LANGUAGES: Language[] = ["en", "fr", "es", "zh"];

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const COLORS = ["red", "blue", "green", "yellow", "black", "white", "orange", "purple"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SUITS = ["hearts", "spades", "clubs", "diamonds"];
const DIRECTIONS = ["north", "south", "east", "west"];
const COINS = ["heads", "tails"];
const BITS = ["0", "1"];
const ELEMENTS = ["hydrogen", "carbon", "oxygen", "iron", "gold", "helium", "neon", "argon"];
const SHAPES = ["circle", "square", "triangle", "hexagon", "pentagon", "star"];

/**
 * Ten tasks. The set spans arithmetic-free recall, free choice and closed enumeration, so a
 * serving change that moves one kind of distribution and not another still shows up.
 */
export const TASKS: Task[] = [
  {
    id: "digit",
    alphabet: DIGITS,
    templates: {
      en: [
        "I am seeding a simulation. Reply with one digit from 0 to 9 and nothing else.",
        "For a quick sampling test, give me a single digit between 0 and 9.",
        "Pick any digit 0-9. Answer with the digit on its own.",
      ],
      fr: [
        "J'initialise une simulation. Reponds par un seul chiffre de 0 a 9.",
        "Pour un test d'echantillonnage, donne un chiffre entre 0 et 9.",
        "Choisis un chiffre de 0 a 9. Reponds uniquement par ce chiffre.",
      ],
      es: [
        "Estoy inicializando una simulacion. Responde con un digito del 0 al 9.",
        "Para una prueba de muestreo, dame un solo digito entre 0 y 9.",
        "Elige un digito del 0 al 9 y responde solo con ese digito.",
      ],
      zh: [
        "我在初始化一个模拟。请只回答一个 0 到 9 之间的数字。",
        "做一个抽样测试，请给出 0 到 9 之间的一个数字。",
        "请任选 0 到 9 中的一个数字，只回答该数字。",
      ],
    },
  },
  {
    id: "letter",
    alphabet: LETTERS,
    templates: {
      en: [
        "Name one letter from a to h for a labelling scheme. Answer with the letter only.",
        "I need an arbitrary label. Give me a single letter between a and h.",
        "Choose a letter in the range a to h and reply with it alone.",
      ],
      fr: [
        "Donne une lettre entre a et h pour un schema d'etiquetage. Reponds par la lettre seule.",
        "J'ai besoin d'une etiquette arbitraire. Donne une lettre de a a h.",
        "Choisis une lettre entre a et h et reponds uniquement par elle.",
      ],
      es: [
        "Dame una letra de la a a la h para un esquema de etiquetado. Responde solo con la letra.",
        "Necesito una etiqueta arbitraria. Da una sola letra entre a y h.",
        "Elige una letra entre a y h y responde solo con ella.",
      ],
      zh: [
        "为标注方案取一个 a 到 h 之间的字母，只回答该字母。",
        "我需要一个任意标签，请给出 a 到 h 中的一个字母。",
        "请从 a 到 h 中选一个字母，只回答这个字母。",
      ],
    },
  },
  {
    id: "coin",
    alphabet: COINS,
    templates: {
      en: [
        "Call a coin toss for me. Answer heads or tails, one word.",
        "We are settling something by coin. Say heads or tails.",
        "Flip a coin and report the side. One word.",
      ],
      fr: [
        "Fais un tirage a pile ou face. Reponds heads ou tails, un mot.",
        "On tranche a la piece. Dis heads ou tails.",
        "Lance une piece et donne le cote. Un seul mot.",
      ],
      es: [
        "Lanza una moneda por mi. Responde heads o tails, una palabra.",
        "Vamos a decidir con una moneda. Di heads o tails.",
        "Tira una moneda y di el lado. Una palabra.",
      ],
      zh: [
        "帮我抛一次硬币，只回答 heads 或 tails。",
        "我们用硬币决定，请说 heads 或 tails。",
        "抛一枚硬币并报出结果，只用一个词。",
      ],
    },
  },
  {
    id: "color",
    alphabet: COLORS,
    templates: {
      en: [
        "Pick a colour for a chart series: red, blue, green, yellow, black, white, orange or purple. One word.",
        "I need a default colour. Choose one of red, blue, green, yellow, black, white, orange, purple.",
        "Name one colour from that list: red, blue, green, yellow, black, white, orange, purple.",
      ],
      fr: [
        "Choisis une couleur pour un graphique parmi red, blue, green, yellow, black, white, orange, purple. Un mot.",
        "Il me faut une couleur par defaut parmi red, blue, green, yellow, black, white, orange, purple.",
        "Donne une couleur de cette liste: red, blue, green, yellow, black, white, orange, purple.",
      ],
      es: [
        "Elige un color para una grafica entre red, blue, green, yellow, black, white, orange, purple. Una palabra.",
        "Necesito un color por defecto entre red, blue, green, yellow, black, white, orange, purple.",
        "Nombra un color de esa lista: red, blue, green, yellow, black, white, orange, purple.",
      ],
      zh: [
        "为图表选一个颜色：red、blue、green、yellow、black、white、orange、purple，只回答一个词。",
        "我需要一个默认颜色，从 red、blue、green、yellow、black、white、orange、purple 中选。",
        "从该列表中说出一个颜色：red、blue、green、yellow、black、white、orange、purple。",
      ],
    },
  },
  {
    id: "day",
    alphabet: DAYS,
    templates: {
      en: [
        "Suggest a day of the week for a recurring meeting. One word, in English.",
        "Pick any weekday name. Answer with the day alone, in English.",
        "Name a day of the week for a standing slot. English, one word.",
      ],
      fr: [
        "Propose un jour de la semaine pour une reunion recurrente. Un mot, en anglais.",
        "Choisis un nom de jour. Reponds par le jour seul, en anglais.",
        "Donne un jour de la semaine pour un creneau fixe. En anglais, un mot.",
      ],
      es: [
        "Sugiere un dia de la semana para una reunion recurrente. Una palabra, en ingles.",
        "Elige un nombre de dia. Responde solo con el dia, en ingles.",
        "Nombra un dia de la semana para un horario fijo. En ingles, una palabra.",
      ],
      zh: [
        "为例会推荐一个星期几，用英文回答一个单词。",
        "请任选一个星期名称，用英文只回答该词。",
        "为固定时段选一个星期几，用英文一个单词回答。",
      ],
    },
  },
  {
    id: "suit",
    alphabet: SUITS,
    templates: {
      en: [
        "Draw a card and tell me the suit: hearts, spades, clubs or diamonds.",
        "Name one card suit. One word.",
        "For a shuffle test, give a suit: hearts, spades, clubs, diamonds.",
      ],
      fr: [
        "Tire une carte et donne la couleur: hearts, spades, clubs ou diamonds.",
        "Nomme une couleur de carte. Un mot.",
        "Pour un test de melange, donne une couleur: hearts, spades, clubs, diamonds.",
      ],
      es: [
        "Saca una carta y di el palo: hearts, spades, clubs o diamonds.",
        "Nombra un palo de la baraja. Una palabra.",
        "Para una prueba de barajado, da un palo: hearts, spades, clubs, diamonds.",
      ],
      zh: [
        "抽一张牌并说出花色：hearts、spades、clubs 或 diamonds。",
        "说出一个扑克花色，只回答一个词。",
        "做洗牌测试，给出一个花色：hearts、spades、clubs、diamonds。",
      ],
    },
  },
  {
    id: "direction",
    alphabet: DIRECTIONS,
    templates: {
      en: [
        "Point me somewhere: north, south, east or west. One word.",
        "Choose a compass direction. Answer with the word alone.",
        "For a random walk, give a direction: north, south, east, west.",
      ],
      fr: [
        "Indique une direction: north, south, east ou west. Un mot.",
        "Choisis un point cardinal. Reponds par le mot seul.",
        "Pour une marche aleatoire, donne une direction: north, south, east, west.",
      ],
      es: [
        "Indica una direccion: north, south, east o west. Una palabra.",
        "Elige un punto cardinal. Responde solo con la palabra.",
        "Para un paseo aleatorio, da una direccion: north, south, east, west.",
      ],
      zh: [
        "给我指一个方向：north、south、east 或 west，只回答一个词。",
        "请选择一个方位，只回答该词。",
        "做随机游走，请给出方向：north、south、east、west。",
      ],
    },
  },
  {
    id: "bit",
    alphabet: BITS,
    templates: {
      en: [
        "Emit one bit for a test vector: 0 or 1.",
        "I need a single bit. Answer 0 or 1.",
        "Give me one binary digit, 0 or 1, on its own.",
      ],
      fr: [
        "Donne un bit pour un vecteur de test: 0 ou 1.",
        "J'ai besoin d'un seul bit. Reponds 0 ou 1.",
        "Donne un chiffre binaire, 0 ou 1, seul.",
      ],
      es: [
        "Emite un bit para un vector de prueba: 0 o 1.",
        "Necesito un solo bit. Responde 0 o 1.",
        "Da un digito binario, 0 o 1, solo.",
      ],
      zh: [
        "为测试向量输出一个比特：0 或 1。",
        "我需要一个比特，请回答 0 或 1。",
        "给出一个二进制数字，0 或 1，单独回答。",
      ],
    },
  },
  {
    id: "element",
    alphabet: ELEMENTS,
    templates: {
      en: [
        "Name one element from hydrogen, carbon, oxygen, iron, gold, helium, neon, argon.",
        "Pick a chemical element from that short list. One word.",
        "For an example, choose: hydrogen, carbon, oxygen, iron, gold, helium, neon, argon.",
      ],
      fr: [
        "Nomme un element parmi hydrogen, carbon, oxygen, iron, gold, helium, neon, argon.",
        "Choisis un element chimique de cette liste. Un mot.",
        "Pour un exemple, choisis: hydrogen, carbon, oxygen, iron, gold, helium, neon, argon.",
      ],
      es: [
        "Nombra un elemento entre hydrogen, carbon, oxygen, iron, gold, helium, neon, argon.",
        "Elige un elemento quimico de esa lista corta. Una palabra.",
        "Para un ejemplo, elige: hydrogen, carbon, oxygen, iron, gold, helium, neon, argon.",
      ],
      zh: [
        "从 hydrogen、carbon、oxygen、iron、gold、helium、neon、argon 中说出一个元素。",
        "从这个短列表中选一个化学元素，只回答一个词。",
        "举例请选择：hydrogen、carbon、oxygen、iron、gold、helium、neon、argon。",
      ],
    },
  },
  {
    id: "shape",
    alphabet: SHAPES,
    templates: {
      en: [
        "Choose a shape for an icon: circle, square, triangle, hexagon, pentagon or star.",
        "Name one shape from that set. One word.",
        "For a placeholder glyph, pick: circle, square, triangle, hexagon, pentagon, star.",
      ],
      fr: [
        "Choisis une forme pour une icone: circle, square, triangle, hexagon, pentagon ou star.",
        "Nomme une forme de cet ensemble. Un mot.",
        "Pour un glyphe provisoire, choisis: circle, square, triangle, hexagon, pentagon, star.",
      ],
      es: [
        "Elige una forma para un icono: circle, square, triangle, hexagon, pentagon o star.",
        "Nombra una forma de ese conjunto. Una palabra.",
        "Para un glifo temporal, elige: circle, square, triangle, hexagon, pentagon, star.",
      ],
      zh: [
        "为图标选一个形状：circle、square、triangle、hexagon、pentagon 或 star。",
        "从该集合中说出一个形状，只回答一个词。",
        "为占位图形选择：circle、square、triangle、hexagon、pentagon、star。",
      ],
    },
  },
];

export interface Cell {
  id: string;
  task: string;
  language: Language;
  alphabet: string[];
}

/** The forty cells: ten tasks across four languages. */
export const CELLS: Cell[] = TASKS.flatMap((t) =>
  LANGUAGES.map((lang) => ({
    id: `${t.id}.${lang}`,
    task: t.id,
    language: lang,
    alphabet: t.alphabet,
  })),
);

export function cellById(id: string): Cell {
  const c = CELLS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown cell ${id}`);
  return c;
}

export function taskById(id: string): Task {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id}`);
  return t;
}

export interface Probe {
  probeId: Hex;
  cellId: string;
  /** The system prompt, from the sampling contract. */
  system: string;
  /** The user message, a paraphrase template with its framing. */
  user: string;
  alphabet: string[];
}

/**
 * Framings that wrap the probe in a request an ordinary caller would send. Combined with the
 * paraphrase templates and the four languages, one cell yields many surface forms of the same
 * measurement.
 */
const FRAMINGS = [
  (q: string) => q,
  (q: string) => `Quick one before I get back to the ticket. ${q}`,
  (q: string) => `${q} No explanation needed, I am scripting this.`,
  (q: string) => `Setting up a fixture for a test suite. ${q}`,
  (q: string) => `${q} Then I will move on to the next field.`,
];

export const DEFAULT_SYSTEM_PROMPT =
  "You are a concise assistant. When asked for a single value, reply with that value and nothing else.";

/**
 * Deterministically generate the probe corpus for a version.
 *
 * `count` probes per cell, enough for `m * T_max` scheduled executions plus redundancy. The
 * corpus is committed by Merkle root at issuance; nothing here is public until the round that
 * spent a probe has sealed.
 */
export function generateProbes(seed: Hex, cellId: string, count: number): Probe[] {
  const cell = cellById(cellId);
  const task = taskById(cell.task);
  const templates = task.templates[cell.language];
  const prng = new Prng(keccakString(`${seed}|probes|${cellId}`));

  return Array.from({ length: count }, (_, i) => {
    const template = templates[prng.nextBelow(templates.length)] as string;
    const framing = FRAMINGS[prng.nextBelow(FRAMINGS.length)] as (q: string) => string;
    return {
      probeId: keccakString(`${seed}|${cellId}|${i}`),
      cellId,
      system: DEFAULT_SYSTEM_PROMPT,
      user: framing(template),
      alphabet: cell.alphabet,
    };
  });
}

/** The leaf a probe commits to in the probe pool. */
export function probeLeafData(p: Probe): string {
  return `${p.probeId}|${p.cellId}|${p.system}|${p.user}`;
}
