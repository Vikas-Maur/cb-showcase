# .cbproj ZipWriter throughput (PLAN §13)

`bench.ts` times `ZipWriter.addFile` (`packages/cardboard/src/node/cbproj/zip.ts`) writing one large file into a
`.cbproj`, against the stream pipeline yazl's `addFile` uses (read stream → CRC transform → write stream, given
`zlib.crc32`) and `fs.copyFileSync` as the floor. The run order rotates, the page cache is warmed first, and the zip it
wrote is read back once (size and CRC). It prints every run and the medians. Node 24, no dependencies, any OS.

```sh
cd carton
flock /tmp/gfv-race/cpu.lock node bench/zip/bench.ts /home/ubuntu/gfv-scratch/carton/verify/zip/src.bin --runs 7 --make-mib 256
```

Put the source on the volume you want to measure; outputs go next to it and are removed. Every number it prints is
UNVERIFIED until a separate verifier re-runs it (AGENTS.md rule 6). Typecheck: `npx tsc -p bench/zip`.
