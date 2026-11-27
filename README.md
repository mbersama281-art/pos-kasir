# Warung Stok

Aplikasi stok + scan foto barang untuk warung Madura.

## Jalankan lokal
```
npm install
ANTHROPIC_API_KEY=sk-ant-xxx npm start
```
Buka http://localhost:3000

## Deploy ke Railway
1. Push folder ini ke GitHub.
2. Railway > New Project > Deploy from GitHub repo.
3. Tab **Variables**, isi:
   - `ANTHROPIC_API_KEY` = API key dari console.anthropic.com
   - `APP_PASSWORD` = password bebas (biar orang lain tidak bisa pakai)
   - `DATA_DIR` = `/data`
4. Tab **Settings > Volumes** > tambah Volume, mount path `/data` (WAJIB, kalau tidak data hilang saat redeploy).
5. Settings > Networking > **Generate Domain**. Buka linknya di HP.
