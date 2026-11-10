# Import, on 1.5.0: the recorded runs (2026-11-10)

The files behind [Import, on 1.5.0](../../benchmarks.md#import-on-150), as the Windows laptop wrote them.

| File | What it is |
| --- | --- |
| [results.md](results.md), [results.json](results.json) | The run: `scripts\bench\run.js` with the baseline and ours, both built from `56142f3f`, 5 counted runs per build after a warm-up, alternating. Every run, the medians, the machine and the clips |
| [power.log](power.log) | The laptop's power source every 30 s during that run (`root/wmi` `BatteryStatus.PowerOnline`) |
| [VERIFY.md](VERIFY.md) | The independent check (AGENTS.md rule 6), by a separate agent: the method, the arithmetic, and two re-runs of the import. Its first re-run doesn't count, and it says why; the clean re-run's verdict is at the end |
| [verify-import-2-results.md](verify-import-2-results.md), [verify-import-2-results.json](verify-import-2-results.json) | The clean re-run: 3 counted runs per build after a warm-up |

The paths in them (`D:\cbwork\bench150\…`) are the laptop's working folder for this run.
