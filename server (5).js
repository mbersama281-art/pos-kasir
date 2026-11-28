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
if (!db.kontak) db.kontak = [];
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Proteksi sederhana pakai password (opsional, set APP_PASSWORD di Railway)
app.use('/api', (req, res, next) => {
  if (PASS && req.get('x-pass') !== PASS) return res.status(401).json({ error: 'Password salah' });
  next();
});

app.get('/api/items', (req, res) => res.json(db.items));

function clean(b){
  const n=v=>Math.max(0,+v||0), t=v=>String(v==null?'':v).trim();
  const o={nama:t(b.nama),satuan:t(b.satuan)||'pcs',isi:n(b.isi),beliDus:n(b.beliDus),beli:n(b.beli),jual:n(b.jual),jualDus:n(b.jualDus),stok:n(b.stok),gudang:n(b.gudang),min:n(b.min),kode:t(b.kode),kodeDus:t(b.kodeDus)};
  if(o.isi<=0){o.isi=0;o.beliDus=0;o.jualDus=0;o.kodeDus='';o.stok+=o.gudang;o.gudang=0;}
  else if(o.beliDus&&!o.beli)o.beli=o.beliDus/o.isi;
  return o;
}
function kodeError(o,id){
  if(o.kode&&o.kode===o.kodeDus) return 'Barcode satuan dan dus tidak boleh sama';
  const ks=[o.kode,o.kodeDus].filter(Boolean);
  const d=db.items.find(i=>i.id!==id&&ks.some(k=>i.kode===k||i.kodeDus===k));
  return d?'Barcode itu sudah dipakai '+d.nama:'';
}
app.post('/api/items',(req,res)=>{
  const o=clean(req.body);
  if(!o.nama) return res.status(400).json({error:'Nama wajib diisi'});
  const e=kodeError(o); if(e) return res.status(400).json({error:e});
  const item={id:uid(),...o}; db.items.push(item); save(); res.json(item);
});
app.put('/api/items/:id',(req,res)=>{
  const it=db.items.find(i=>i.id===req.params.id);
  if(!it) return res.status(404).json({error:'Tidak ada'});
  const o=clean({...it,...req.body});
  if(!o.nama) return res.status(400).json({error:'Nama wajib diisi'});
  const e=kodeError(o,it.id); if(e) return res.status(400).json({error:e});
  Object.assign(it,o); save(); res.json(it);
});
app.delete('/api/items/:id',(req,res)=>{
  db.items=db.items.filter(i=>i.id!==req.params.id); save(); res.json({ok:true});
});
function snap(){return {s:db.items.map(i=>[i.id,i.stok,i.gudang||0]),t:db.tx.length}}
function restore(x){x.s.forEach(([id,st,g])=>{const i=db.items.find(z=>z.id===id);if(i){i.stok=st;i.gudang=g}});db.tx.length=x.t}
// stok warung = satuan (dijual). stok gudang = dus (belanjaan). Semua disimpan dalam satuan kecil.
function applyMove(type,it,unit,qty){
  if(unit==='dus'&&!(it.isi>0)) throw new Error(it.nama+': isi per dus belum diisi');
  const base=unit==='dus'?qty*it.isi:qty;
  it.gudang=it.gudang||0;
  if(type==='out'){
    let take=base;
    if(unit==='dus'){const g=Math.min(it.gudang,take);it.gudang-=g;take-=g}
    if(take>it.stok){
      const dus=it.isi>0?Math.floor(it.gudang/it.isi):0;
      throw new Error('Stok warung '+it.nama+' kurang (sisa '+it.stok+' '+it.satuan+')'+(unit!=='dus'&&dus>0?'. Di gudang ada '+dus+' dus, pindahkan ke warung dulu.':''));
    }
    it.stok-=take;
  } else if(unit==='dus') it.gudang+=base; else it.stok+=base;
  const jual=unit==='dus'?(it.jualDus||it.jual*it.isi)/it.isi:it.jual;
  db.tx.push({id:uid(),t:Date.now(),itemId:it.id,nama:it.nama,type,qty:base,jual,beli:it.beli});
}
app.post('/api/items/:id/move',(req,res)=>{
  const it=db.items.find(i=>i.id===req.params.id);
  if(!it) return res.status(404).json({error:'Tidak ada'});
  const qty=Math.abs(+req.body.qty||0);
  if(!qty) return res.status(400).json({error:'Jumlah tidak valid'});
  const sn=snap();
  try{ applyMove(req.body.type==='in'?'in':'out',it,req.body.unit==='dus'?'dus':'satuan',qty); }
  catch(e){ restore(sn); return res.status(400).json({error:e.message}); }
  save(); res.json(it);
});
// Pindahkan dus dari gudang ke warung (buka dus -> jadi satuan)
app.post('/api/items/:id/pindah',(req,res)=>{
  const it=db.items.find(i=>i.id===req.params.id);
  if(!it) return res.status(404).json({error:'Tidak ada'});
  if(!(it.isi>0)) return res.status(400).json({error:'Barang ini belum punya isi per dus'});
  const dus=Math.abs(+req.body.qty||0), base=dus*it.isi;
  if(!dus) return res.status(400).json({error:'Jumlah tidak valid'});
  if(base>(it.gudang||0)) return res.status(400).json({error:'Stok gudang kurang (sisa '+(Math.floor((it.gudang||0)/it.isi))+' dus)'});
  it.gudang-=base; it.stok+=base; save(); res.json(it);
});
app.post('/api/checkout',(req,res)=>{
  const type=req.body.type==='in'?'in':'out';
  const lines=(req.body.lines||[]).map(l=>({itemId:l.itemId,unit:l.unit==='dus'?'dus':'satuan',qty:+l.qty})).filter(l=>l.qty>0);
  if(!lines.length) return res.status(400).json({error:'Daftar kosong'});
  for(const l of lines){
    const it=db.items.find(i=>i.id===l.itemId);
    if(!it) return res.status(400).json({error:'Ada barang yang sudah dihapus'});
    if(l.unit==='dus'&&!(it.isi>0)) return res.status(400).json({error:it.nama+': isi per dus belum diisi'});
  }
  const sn=snap();
  try{ for(const l of lines) applyMove(type,db.items.find(i=>i.id===l.itemId),l.unit,l.qty); }
  catch(e){ restore(sn); return res.status(400).json({error:e.message}); }
  save(); res.json({ok:true});
});

app.get('/api/report', (req, res) => {
  // hari dihitung pakai zona waktu WIB (UTC+7), ubah lewat TZ_OFFSET_HOURS kalau perlu
  const OFF = (+process.env.TZ_OFFSET_HOURS || 7) * 36e5;
  const dayStart = t => Math.floor((t + OFF) / 864e5) * 864e5 - OFF;
  const start = dayStart(Date.now());
  const week = start - 6 * 864e5;
  const out = db.tx.filter(t => t.type === 'out');
  const sum = list => ({
    omzet: list.reduce((a, t) => a + t.jual * t.qty, 0),
    untung: list.reduce((a, t) => a + (t.jual - t.beli) * t.qty, 0),
    terjual: list.reduce((a, t) => a + t.qty, 0)
  });
  const top = {};
  out.filter(t => t.t >= week).forEach(t => top[t.nama] = (top[t.nama] || 0) + t.qty);
  const harian = [];
  for (let k = 6; k >= 0; k--) {
    const a = start - k * 864e5, e = a + 864e5;
    harian.push({ tgl: new Date(a + OFF).toISOString().slice(0, 10), ...sum(out.filter(t => t.t >= a && t.t < e)) });
  }
  res.json({
    harian,
    hariIni: sum(out.filter(t => t.t >= start)),
    mingguIni: sum(out.filter(t => t.t >= week)),
    terlaris: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([nama, qty]) => ({ nama, qty })),
    nilaiStok: db.items.reduce((a, i) => a + i.beli * (i.stok + (i.gudang || 0)), 0),
    nilaiWarung: db.items.reduce((a, i) => a + i.beli * i.stok, 0),
    nilaiGudang: db.items.reduce((a, i) => a + i.beli * (i.gudang || 0), 0)
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


// ---- Pesanan ke gudang / supplier ----
app.get('/api/orders', (req, res) => res.json(db.orders.slice().reverse()));

app.post('/api/orders', (req, res) => {
  const b = req.body;
  if (!b.nama) return res.status(400).json({ error: 'Nama gudang / supplier wajib diisi' });
  const lines = (b.lines || []).map(l => {
    const it = db.items.find(i => i.id === l.itemId);
    if (!it || !(+l.qty > 0)) return null;
    const unit = l.unit === 'dus' && it.isi > 0 ? 'dus' : 'satuan';
    return { itemId: it.id, nama: it.nama, satuan: it.satuan, unit, qty: +l.qty,
      harga: unit === 'dus' ? (it.beliDus || it.beli * it.isi) : it.beli };
  }).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Pilih minimal 1 barang' });
  const o = { id: uid(), t: Date.now(), nama: String(b.nama).trim(), catatan: b.catatan || '', lines, status: 'baru', gudang: true };
  db.orders.push(o); save(); res.json(o);
});

// Barang dari gudang sudah datang -> stok bertambah
app.post('/api/orders/:id/done', (req, res) => {
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ada' });
  if (!o.gudang) return res.status(400).json({ error: 'Ini pesanan format lama (pelanggan). Hapus saja.' });
  if (o.status === 'selesai') return res.status(400).json({ error: 'Sudah ditandai datang' });
  for (const l of o.lines) {
    if (!db.items.find(i => i.id === l.itemId)) return res.status(400).json({ error: l.nama + ' sudah dihapus dari stok' });
  }
  const sn = snap();
  try { for (const l of o.lines) applyMove('in', db.items.find(i => i.id === l.itemId), l.unit || 'satuan', l.qty); }
  catch (e) { restore(sn); return res.status(400).json({ error: e.message }); }
  o.status = 'selesai'; o.tglDatang = Date.now(); save(); res.json(o);
});

app.delete('/api/orders/:id', (req, res) => {
  db.orders = db.orders.filter(x => x.id !== req.params.id);
  save(); res.json({ ok: true });
});

app.get('/api/tx', (req, res) => {
  const n = Math.min(+(req.query && req.query.n) || 30, 500);
  res.json(db.tx.slice(-n).reverse());
});
app.get('/api/kontak', (req, res) => {
  const j = req.query && req.query.jenis;
  res.json(db.kontak.filter(k => !j || k.jenis === j));
});
app.post('/api/kontak', (req, res) => {
  const b = req.body;
  if (!String(b.nama || '').trim()) return res.status(400).json({ error: 'Nama wajib diisi' });
  const k = { id: uid(), jenis: b.jenis === 'supplier' ? 'supplier' : 'pelanggan', nama: String(b.nama).trim(), hp: String(b.hp || '').trim(), catatan: String(b.catatan || '').trim() };
  db.kontak.push(k); save(); res.json(k);
});
app.delete('/api/kontak/:id', (req, res) => {
  db.kontak = db.kontak.filter(k => k.id !== req.params.id); save(); res.json({ ok: true });
});

app.get('/api/backup', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="warung-stok-cadangan.json"');
  res.json(db);
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Warung Stok jalan'));
