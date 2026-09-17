# Plan: Streaming Responsiveness (Coalesced Deltas)

Dokumen ini merinci rencana dan implementasi untuk meningkatkan responsivitas
streaming opencode, mengikuti item backlog resmi di `specs/v2/todo.md` dan
checklist di `packages/core/src/session/runner/llm.ts`:

> "Coalesce streamed deltas and add covering projected-history indexes."

## Latar belakang

### Jalur delta saat ini (traced dari kode)

```
llm.stream(request)                      (provider turn, packages/core/src/session/runner/llm.ts)
  └─ for each LLMEvent (per token!):
       publisher.publish(event)          (runner/publish-llm-event.ts, digembok Semaphore(1))
         └─ events.publish(SessionEvent.Text.Delta | Reasoning.Delta | Tool.Input.Delta)
              └─ EventV2.notify()        (packages/core/src/event.ts — LIVE-ONLY, tanpa SQLite)
                   ├─ listeners[]        → event-v2-bridge.ts → GlobalBus.emit("event", ...)
                   │                        ├─ TUI (via tui-event)
                   │                        └─ HTTP SSE → desktop/web app → Solid store update
                   └─ PubSub typed/all     → subscriber lain (SDK, dsb.)
```

### Temuan penting

1. **Delta sudah live-only, bukan durable.** Di `packages/schema/src/session-event.ts`,
   `Text.Delta` / `Reasoning.Delta` / `Tool.Input.Delta` tidak memiliki opsi
   `durable`, dengan komentar eksplisit: _"Stream fragments are live-only;
   Text.Ended is the replayable full-value boundary."_ Artinya bottleneck-nya
   **bukan** penulisan SQLite per token.

2. **Biaya yang nyata per token** (untuk respons sepanjang ribuan token):
   - alokasi payload event + pembuatan ULID per delta (`event.ts` `publish`),
   - `notify()` mengiterasi semua listener dan dua PubSub per delta,
   - bridge menerjemahkan tiap delta menjadi satu `GlobalBus` event
     (serialisasi JSON per pesan per client SSE),
   - client (app) menjalankan reducer + update store Solid per delta
     (re-render per token).

3. **Index history sudah memadai.** `readAggregate` (aggregate_id + seq +
   type IN, ORDER BY seq) dilayani `event_aggregate_seq_idx` dan
   `event_aggregate_type_seq_idx`; `entriesForRunner`
   (`session_id = ? ... ORDER BY seq`) dilayani
   `session_message_session_seq_idx`. Karena itu **tidak ada migrasi index
   baru** pada fase ini — menambah index tanpa bukti `EXPLAIN QUERY PLAN`
   berisiko salah jalan (biaya tulis + migrasi tanpa manfaat terukur).

## Ruang lingkup Fase 1 (diimplementasikan sekarang)

### Delta coalescing yang semantics-preserving

Menggabungkan delta beruntun **per fragmen** (text / reasoning / tool-input)
menjadi satu event, tanpa mengubah hasil akhir di konsumen mana pun:

- **Invariant urutan**: untuk tiap fragmen, gabungan `delta` yang diterbitkan
  selalu `==` gabungan chunk provider, dengan urutan sama.
- **Boundary flush** (dijalankan di dalam semaphore runner, jadi terserialisasi):
  - sebelum `Text.Ended` / `Reasoning.Ended` / `Tool.Input.Ended`,
  - sebelum settlement `step-finish` dan `failAssistant` (via `flush()`),
  - saat `flush()` pada `Effect.ensuring` — mencakup abort/interrupt.
- **Window flush**: fiber scoped di runner mem-flush buffer tiap 50 ms
  (batas atas ~20 event/detik/fragmen, dibanding ratusan token/detik).
- **Threshold flush**: bila buffer satu fragmen mencapai 16 KB, langsung
  terbit (melindungi tool-input besar seperti `write` file).

Konfigurasi diekspor sebagai `STREAM_DELTA_COALESCE`
(`packages/core/src/session/runner/publish-llm-event.ts`) dan dapat
dinonaktifkan via opsi `coalesce: false` bagi pemanggil langsung publisher
(legacy 1:1).

### Kenapa aman untuk konsumen

- `message-updater.ts` melakukan `match.text += event.data.delta` — hasil
  konkatenasi identik berapa pun pembagiannya.
- Bridge/GlobalBus/app reducer meng-append akumulator per part — identik.
- Read-model durable hanya bergantung pada event `Started`/`Ended` — tidak
  tersentuh sama sekali.
- Satu-satunya perubahan kontrak: **jumlah** event live tidak lagi 1:1 dengan
  chunk provider. Test `verifyEphemeralDeltas` disesuaikan dari "harus tepat
  32" menjadi "gabungan delta harus identik dan tidak ada yang tersimpan
  durable" — inilah kontrak yang sebenarnya bermakna.

## Di luar ruang lingkup (didokumentasikan agar tidak salah jalan)

- **Compaction delta** (`Compaction.Delta`): jalur terpisah
  (`SessionCompaction`), calon fase lanjutan dengan pola sama.
- **Legacy V1 loop** (`SessionPrompt.loop` → `session.updatePartDelta` →
  `Bus` `message.part.delta`): sengaja tidak disentuh — jalur V2 adalah masa
  depan sesuai `todo.md`; koalesensi ganda di dua tempat menambah risiko.
- **Migrasi index baru**: menunggu bukti `EXPLAIN QUERY PLAN`/profil.
- Item todo berikutnya: replayable event cursor HTTP/SDK, BackgroundJob,
  durable interruption/retry — terdaftar di `todo.md`, butuh desain masing-
  masing; coalescing di fase 1 adalah prasyarat yang mengurangi beban client
  untuk ketiganya.

## Verifikasi

```sh
# unit semantics coalescing (deterministik, tanpa timer)
cd packages/core && bun test test/session-runner-delta-coalesce.test.ts

# kontrak publisher tool events (regresi)
bun test test/session-runner-tool-events.test.ts

# integrasi penuh session runner, termasuk ephemeral deltas yang direvisi
bun test test/session-runner.test.ts

# typecheck
bun run typecheck
```
