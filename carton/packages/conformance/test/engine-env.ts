// The prototype's env overrides for the engine suites' counts (FUZZ, DAG, MULTI, DET, TP1; unset: the prototype's
// defaults), and where file-writing tests put their files.
const n = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
export const counts = { fuzz: n(process.env.FUZZ), dag: n(process.env.DAG), multi: n(process.env.MULTI), det: n(process.env.DET), tp1: n(process.env.TP1) };
export const tmpDir = process.env.CARTON_TEST_TMP || undefined;
