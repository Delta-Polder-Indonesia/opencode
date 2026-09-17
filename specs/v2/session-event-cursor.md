# Session Event Cursor: Replayable Session Events over HTTP/SDK

Status: **implemented & terverifikasi** (per 2026-09). Dokumen ini merinci kontrak,
cara konsumsi yang benar, dan matriks verifikasinya — agar adopsi oleh konsumen
(remote desktop/web app, SDK eksternal) tidak salah jalan.

Item backlog terkait di `specs/v2/todo.md`:

> "expose replayable Session event cursors over HTTP and the generated SDK where remote consumers need them"

## Apa yang sudah ada (diverifikasi lewat route-coverage harness)

| Lapisan              | Lokasi                                                                                                                                                                   | Status |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Core service         | `SessionV2.history` / `SessionV2.events` (`packages/core/src/session.ts`)                                                                                                | ✅     |
| Engine replay+cursor | `EventV2.readAggregate` (paginated) & `EventV2.durable` (replay-then-live) (`packages/core/src/event.ts`)                                                                | ✅     |
| Kontrak HTTP         | `GET /api/session/:sessionID/history` (`v2.session.history`), `GET /api/session/:sessionID/event` (`v2.session.events`, SSE) (`packages/protocol/src/groups/session.ts`) | ✅     |
| Handler server       | `packages/server/src/handlers/session.ts` (`session.history`, `session.events`)                                                                                          | ✅     |
| SDK tergenerate      | `packages/sdk/js/src/v2/gen` (`/api/session/{sessionID}/history`, `/api/session/{sessionID}/event`)                                                                      | ✅     |
| Route coverage       | `v2.session.history`, `.missing`, `.invalid`, `v2.session.events.missing` + **baru: `.cursor` untuk keduanya**                                                           | ✅     |

## Kontrak

### `GET /api/session/{sessionID}/history` — halaman riwayat finit

- Query: `after?: number` (eksklusif, `NonNegativeInt`; omit = dari awal), `limit?: number` (≤ 100, default server).
- Response: `{ data: SessionEvent.Durable[], hasMore: boolean }`.
- Tiap event membawa `durable: { aggregateID, seq, version }` — **`seq` adalah cursor**.
- Semantik penting:
  - `seq` berlaku untuk **seluruh aggregate sesi** (termasuk event V1 durable seperti `session.created`),
    tetapi halaman ini **hanya berisi tipe `session.next.*`** yang ada di manifest `SessionDurable`.
    Artinya `seq` bisa meloncat — itu normal, bukan event hilang.
  - `after` eksklusif: halaman berikutnya mulai dari `seq > after`.
  - `hasMore` dihitung dari pembacaan `limit + 1`, jadi bisa dipercaya untuk loop catch-up.

### `GET /api/session/{sessionID}/event` — stream SSE replay-then-live

- Query: `after?: number` (eksklusif; omit = replay penuh lalu live).
- Implementasi `EventV2.durable` **subscribe dulu, baru membaca riwayat** — jadi tidak ada celah
  (gap) antara replay dan live: event yang commit di antaranya tetap terkirim satu kali.
- Tipe payload sama dengan history (`SessionEvent.Durable`).

### Relasi dengan delta live (dari streaming-responsiveness.md)

Delta streaming (`text.delta`, dst.) **live-only** dan tidak pernah melewati kanal cursor ini.
Konsumen cursor menerima batas `*.ended` full-value — state akhir selalu benar tanpa delta.
Konsumen yang butuh animasi token tetap menggunakan bus live (`/event`), bukan kanal ini.

## Resep konsumen (catch-up + live tail)

```ts
// 1) Catch-up: kumpulkan semua halaman sampai hasMore === false.
let after: number | undefined = resumeFrom // cursor persisten terakhir, undefined = awal
for (;;) {
  const page = await client.session.history({ sessionID, limit: 100, after })
  for (const event of page.data) project(event) // replay ke read-model lokal
  if (!page.hasMore) break
  after = page.data.at(-1)!.durable!.seq
}
// 2) Live tail: lanjutkan dari cursor terakhir. Tidak ada gap (subscribe-before-read).
if (after !== undefined || true) {
  const stream = client.session.events({ sessionID, after })
  for await (const event of stream) {
    project(event)
    after = event.durable!.seq // persist untuk resume berikutnya
  }
}
```

## Matriks verifikasi

| Skenario                               | Apa yang dibuktikan                                                                              | Lokasi            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------- |
| `v2.session.history`                   | 200 + bentuk `{data, hasMore}`                                                                   | exercise index.ts |
| `v2.session.history.cursor` **(baru)** | `after` eksklusif, halaman terurut & disjoint, `hasMore` false di akhir, event resume tepat satu | exercise index.ts |
| `v2.session.history.missing`           | 404 sesi tidak ada                                                                               | exercise index.ts |
| `v2.session.history.invalid`           | 400 untuk `after=-1` (bukan `NonNegativeInt`)                                                    | exercise index.ts |
| `v2.session.events.cursor` **(baru)**  | SSE 200 + `text/event-stream`, replay tepat `seq > after`, cursor sendiri tidak ikut             | exercise index.ts |
| `v2.session.events.missing`            | 404 sesi tidak ada                                                                               | exercise index.ts |

Menjalankan subset:

```sh
cd packages/opencode
bun run script/httpapi-exercise.ts --mode coverage --include v2.session.history --trace
bun run script/httpapi-exercise.ts --mode coverage --include v2.session.events --trace
```

Catatan: di sandbox offline, `--mode effect` memiliki kegagalan pre-existing pada skenario
yang bergantung model/provider eksternal (`session.prompt*`, `provider.list`, …) —
diverifikasi gagal identik pada tree baseline tanpa perubahan ini.

## Sisa pekerjaan (slice terpisah, belum dikerjakan)

- **Adopsi konsumen**: app desktop/web (`packages/app`) saat ini memuat ulang pesan penuh
  - live bus; memakai kanal cursor untuk resume inkrimental adalah slice tersendiri yang
    bergantung "New Data Mode" (`packages/app/V1_API_MIGRATION.md`).
- **Last-Event-ID**: SSE spec-native resume id bisa ditambah kemudian tanpa mengubah kontrak
  query `after` (keduanya kompatibel).
