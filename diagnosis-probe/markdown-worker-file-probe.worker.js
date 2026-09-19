// Pendamping markdown-worker-file-probe.html — berdiri di protokol minimum
// agar halaman probe dapat membedakan "worker hidup" vs "worker tidak bisa
// dibuat/di-load". Bukan kode aplikasi.
self.onmessage = (event) => {
  if (event.data === "ping") {
    self.postMessage("pong")
  }
}
