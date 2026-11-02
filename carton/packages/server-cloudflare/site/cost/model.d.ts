// Types for model.js (plain JavaScript, so the page needs no build step), for the tests' typecheck.

export type Storage = "r2" | "vault";
export type Plan = "free" | "paid";

export interface Settings {
  people: number;
  teams: number;
  days: number;
  hoursPerDay: number;
  idleHoursPerDay: number;
  savesPerMinute: number;
  agentEditsPerDay: number;
  dragShare: number;
  connectsPerDay: number;
  footageHoursPerMonth: number;
  previewMbps: number;
  shareOriginals: boolean;
  originalMbps: number;
  retentionMonths: number;
  viewShare: number;
  storage: Storage;
  plan: Plan;
  segmentSeconds: number;
}

export type InputKey = keyof typeof INPUT_DEFAULTS;
export type Inputs = Record<InputKey, number>;
/** data.json's inputs (`{ value, status, … }`), bare numbers, or anything else: unknown or bad entries are ignored. */
export type GivenInputs = Partial<Record<string, number | { value?: unknown } | unknown>>;

export interface PriceTier { included: number; per: number; perUnit: number; /** rounded up to the next whole unit */ round?: boolean }
export interface Prices {
  fetched?: string;
  paid: { base: number; workersReq: PriceTier; workersCpuMs: PriceTier; doReq: PriceTier; doGBs: PriceTier; doRowsRead: PriceTier; doRowsWritten: PriceTier; doStorageGBMonth: PriceTier; wsMessagesPerRequest: number; doObjectGB: number };
  free: { workersReqDay: number; workersCpuMsPerRequest: number; doReqDay: number; doGBsDay: number; doRowsReadDay: number; doRowsWrittenDay: number; doStorageGB: number; doObjectGB: number };
  r2: { storageGBMonth: PriceTier; classA: PriceTier; classB: PriceTier; egress: number };
}

export type MeterKey = "workersReq" | "workersCpuMs" | "doReq" | "doGBs" | "doRowsRead" | "doRowsWritten" | "doStorageGB" | "r2StorageGB" | "r2ClassA" | "r2ClassB";
export type Meters = Record<MeterKey | "doReqWs", number>;
export type ActivityKey = "fee" | "edits" | "presence" | "connections" | "segments" | "originals" | "storage" | "playback";

export interface Usage {
  settings: Settings;
  inputs: Inputs;
  activities: Record<Exclude<ActivityKey, "fee">, Meters>;
  totals: Meters;
  derived: Record<"edits" | "presenceMsgs" | "presenceAlarms" | "connects" | "idleHours" | "upkeepAlarms" | "footageHours" | "proxyGB" | "segments" | "segMiB" | "originalsGB" | "storedGB" | "viewedMiB" | "editHours" | "roomGB" | "vaultGB", number> & { roomCapped: boolean; vaultCapped: boolean };
}

export interface MeterRow {
  key: MeterKey;
  product: "workers" | "do" | "r2";
  name: string;
  unit: string;
  used: number;
  wsMessages?: number;
  included: number | null;
  billable: number;
  price: PriceTier;
  cost: number;
}
export interface Line { key: ActivityKey; name: string; cost: number; byMeter: Partial<Record<MeterKey, number>> }
export interface Capacity { ok: boolean; what: "vault" | "room"; objectGB: number; limitGB: number }
export interface Bill { plan: Plan; settings: Settings; usage: Usage; meters: MeterRow[]; lines: Line[]; total: number; perUser: number; people: number; capacity: Capacity }

export interface FreeLimitCheck { key: MeterKey | "doObjectGB"; name: string; total: boolean; perObject?: boolean; perTeam: number; used: number; limit: number; maxTeams: number; breaksAt: number; over: boolean }
export interface FreeCheck {
  fits: boolean;
  first: FreeLimitCheck | null;
  checks: FreeLimitCheck[];
  sorted: FreeLimitCheck[];
  cpu: { limit: number; worst: { what: string; ms: number; used: boolean } | null; over: boolean; basis: "average" };
  maxTeams: number;
}
export interface Suggestion { driver: ActivityKey | "limit" | "capacity" | null; lever?: ActivityKey; text: string; saving: number; newTotal?: number; paidTotal?: number | null; alternative?: { storage: Storage; plan: Plan; total: number } }
export interface Result extends Bill { free: FreeCheck; driver: Line | null; suggestion: Suggestion }
export interface Series { key: string; storage: Storage; plan: Plan; maxTeams: number; capacity: Capacity; points: { teams: number; total: number | null }[] }

export const REF_SEGMENT: { seconds: number; mbps: number };
export const ARCHIVE_KEEP: number;
export const FREE_WS_RATIO: number;
export const INPUT_DEFAULTS: Readonly<{
  editDoReq: number; editRowsWritten: number; editRowsRead: number; editGBs: number; editWorkerCpuMs: number; editArchiveRowsWritten: number; changeBytes: number;
  connWorkerReq: number; connWorkerCpuMs: number; connDoReq: number; connRowsWritten: number; connRowsRead: number; connGBs: number;
  presenceMsgPerSecWhileDragging: number; presenceDoReq: number; presenceGBs: number; presenceAlarmPerHour: number; upkeepAlarmPerHour: number; alarmRowsWritten: number; alarmGBs: number;
  idleDoReqPerHour: number; idleGBsPerHour: number; idleRowsWrittenPerHour: number;
  gbWorkerReq: number; gbWorkerCpuMs: number; gbR2ClassA: number; gbR2ClassB: number; gbDoReq: number; gbVaultDoReq: number; gbVaultRowsWritten: number; gbVaultGBs: number;
  segWorkerReq: number; segWorkerCpuMs: number; segR2ClassA: number; segR2ClassB: number; segVaultDoReq: number; segVaultRowsWritten: number;
  viewWorkerReqPerMiB: number; viewClassBPerMiB: number; viewWorkerCpuMsPerMiB: number; viewVaultRowsReadPerMiB: number; viewVaultGBsPerMiB: number;
}>;
export const PREVIEW_QUALITY: Readonly<Record<"540p" | "720p" | "1080p", number>>;
export const DEFAULT_SETTINGS: Readonly<Settings>;
export const PRESETS: Readonly<Record<"solo" | "team5" | "studio20" | "teams1k" | "teams10k", { label: string; settings: Partial<Settings> }>>;
export const METERS: readonly { key: MeterKey; product: "workers" | "do" | "r2"; name: string; unit: string }[];
export const ACTIVITIES: readonly { key: ActivityKey; name: string }[];

export function normalizeSettings(s?: Partial<Settings> | Record<string, unknown> | null): Settings;
export function capacity(u: Usage, prices: Prices, plan: Plan): Capacity;
export function resolveInputs(given?: GivenInputs): Inputs;
export function usage(settings: Partial<Settings>, inputs?: GivenInputs): Usage;
export function bill(settings: Partial<Settings> | null, inputs: GivenInputs | undefined, prices: Prices): Bill;
export function freeCheck(settings: Partial<Settings> | null, inputs: GivenInputs | undefined, prices: Prices): FreeCheck;
export function compute(settings: Partial<Settings> | null, inputs: GivenInputs | undefined, prices: Prices): Result;
export function teamSteps(max?: number): number[];
export function curve(settings: Partial<Settings>, inputs: GivenInputs | undefined, prices: Prices, steps?: number[]): Series[];
