const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '8mb' }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PASS = process.env.APP_PASSWORD || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { items: [], tx: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
if (!db.orders) db.orders = [];
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Proteksi sederhana pakai password (opsional, set APP_PASSWORD di Railway)
app.use('/api', (req, res, next) => {
  if (PASS && req.get('x-pass') !== PASS) return res.status(401).json({ error: 'Password salah' });
  next();
});

app.get('/api/items', (req, res) => res.json(db.items));

app.post('/api/items', (req, res) => {
  const b = req.body;
  if (!b.nama) return res.status(400).json({ error: 'Nama wajib diisi' });
  const item = {
    id: uid(), nama: String(b.nama).trim(), satuan: b.satuan || 'pcs',
    beli: +b.beli || 0, jual: +b.jual || 0, stok: +b.stok || 0, min: +b.min || 0
  };
  db.items.push(item); save(); res.json(item);
});

app.put('/api/items/:id', (req, res) => {
  const it = db.items.find(i => i.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Tidak ada' });
  const b = req.body;
  Object.assign(it, {
    nama: b.nama ?? it.nama, satuan: b.satuan ?? it.satuan,
    beli: +b.beli || 0, jual: +b.jual || 0, stok: +b.stok || 0, min: +b.min || 0
  });
  save(); res.json(it);
});

app.delete('/api/items/:id', (req, res) => {
  db.items = db.items.filter(i => i.id !== req.params.id);
  save(); res.json({ ok: true });
});

// Barang masuk / keluar (jual)
app.post('/api/items/:id/move', (req, res) => {
  const it = db.items.find(i => i.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Tidak ada' });
  const qty = Math.abs(+req.body.qty || 0);
  const type = req.body.type;
  if (!qty) return res.status(400).json({ error: 'Jumlah tidak valid' });
  if (type === 'out') {
    if (qty > it.stok) return res.status(400).json({ error: 'Stok tidak cukup (sisa ' + it.stok + ')' });
    it.stok -= qty;
  } else it.stok += qty;
  db.tx.push({ id: uid(), t: Date.now(), itemId: it.id, nama: it.nama, type, qty,
    jual: it.jual, beli: it.beli });
  save(); res.json(it);
});

app.get('/api/report', (req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const week = Date.now() - 7 * 864e5;
  const out = db.tx.filter(t => t.type === 'out');
  const sum = list => ({
    omzet: list.reduce((a, t) => a + t.jual * t.qty, 0),
    untung: list.reduce((a, t) => a + (t.jual - t.beli) * t.qty, 0),
    terjual: list.reduce((a, t) => a + t.qty, 0)
  });
  const top = {};
  out.filter(t => t.t >= week).forEach(t => top[t.nama] = (top[t.nama] || 0) + t.qty);
  res.json({
    hariIni: sum(out.filter(t => t.t >= start.getTime())),
    mingguIni: sum(out.filter(t => t.t >= week)),
    terlaris: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([nama, qty]) => ({ nama, qty })),
    nilaiStok: db.items.reduce((a, i) => a + i.beli * i.stok, 0)
  });
});

// Scan foto -> AI vision
app.post('/api/scan', async (req, res) => {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY belum diset di Railway' });
    const data = String(req.body.image || '').replace(/^data:image\/\w+;base64,/, '');
    if (!data) return res.status(400).json({ error: 'Foto kosong' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: 'Ini foto barang dagangan warung di Indonesia. Kenali produknya. ' +
            'Balas HANYA JSON tanpa teks lain: {"nama":"nama produk + merek + ukuran, contoh: Indomie Goreng 85g",' +
            '"satuan":"pcs/bungkus/botol/renteng/dus/kg/liter","barcode":"angka barcode jika terbaca, kalau tidak kosong",' +
            '"yakin":"tinggi/sedang/rendah"}. Jika bukan produk, isi nama dengan "".' }
        ] }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: j.error?.message || 'Gagal memanggil AI' });
    const txt = (j.content || []).map(c => c.text || '').join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'AI tidak memberi hasil yang bisa dibaca' });
    const out = JSON.parse(m[0]);
    const nama = String(out.nama || '').toLowerCase();
    const match = nama && db.items.find(i => {
      const n = i.nama.toLowerCase();
      return n === nama || n.includes(nama) || nama.includes(n);
    });
    res.json({ ...out, match: match || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---- Pesanan ----
app.get('/api/orders', (req, res) => res.json(db.orders.slice().reverse()));

app.post('/api/orders', (req, res) => {
  const b = req.body;
  if (!b.nama) return res.status(400).json({ error: 'Nama pemesan wajib diisi' });
  const lines = (b.lines || []).map(l => {
    const it = db.items.find(i => i.id === l.itemId);
    return it && +l.qty > 0 ? { itemId: it.id, nama: it.nama, satuan: it.satuan, qty: +l.qty } : null;
  }).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Pilih minimal 1 barang' });
  const o = { id: uid(), t: Date.now(), nama: String(b.nama).trim(), catatan: b.catatan || '', lines, status: 'baru' };
  db.orders.push(o); save(); res.json(o);
});

app.post('/api/orders/:id/done', (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ada' });
  if (o.status === 'selesai') return res.status(400).json({ error: 'Sudah selesai' });
  for (const l of o.lines) {
    const it = db.items.find(i => i.id === l.itemId);
    if (!it) return res.status(400).json({ error: l.nama + ' sudah dihapus dari stok' });
    if (it.stok < l.qty) return res.status(400).json({ error: 'Stok ' + it.nama + ' kurang (sisa ' + it.stok + ')' });
  }
  for (const l of o.lines) {
    const it = db.items.find(i => i.id === l.itemId);
    it.stok -= l.qty;
    db.tx.push({ id: uid(), t: Date.now(), itemId: it.id, nama: it.nama, type: 'out', qty: l.qty, jual: it.jual, beli: it.beli });
  }
  o.status = 'selesai'; save(); res.json(o);
});

app.delete('/api/orders/:id', (req, res) => {
  db.orders = db.orders.filter(x => x.id !== req.params.id);
  save(); res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Warung Stok jalan'));
