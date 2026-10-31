# Lucky Bienie Cloud

Aplikasi kasir Lucky Bienie (fitur dan tampilan sama seperti sebelumnya) dengan data di cloud (Supabase)
yang tersinkron antar HP/komputer, dan tetap bisa dipakai saat internet putus.

## Isi folder
- `index.html` aplikasi (desain dan fitur Lucky Bienie)
- `cloud.js` login dan sinkronisasi data  |  `supabase.js` library Supabase (disimpan lokal agar bisa offline)
- `config.js` alamat dan kunci publik Supabase  |  `api/users.js` fungsi server untuk kelola akun staf
- `supabase/schema.sql` tabel database  |  `sw.js`, `manifest.json`, ikon: PWA / APK

## Langkah pasang (sekali saja)
1. **Supabase**: buat proyek BARU (disarankan jangan dicampur dengan Shanum Store). Buka SQL Editor, tempel isi
   `supabase/schema.sql`, klik Run.
2. **Authentication > Sign In / Providers**: matikan *Confirm email*, lalu matikan *Allow new users to sign up*
   (setelah akun owner dibuat).
3. **Authentication > Users > Add user > Create new user**: email `owner@luckybienie.app` (boleh email lain),
   isi password, centang *Auto Confirm User*. Akun pertama otomatis menjadi **owner**.
4. **config.js**: isi `url` (Project URL) dan `key` (publishable/anon key) dari Project Settings > API.
   Jangan isi secret/service_role di file ini.
5. **GitHub + Vercel**: unggah seluruh isi folder ini ke repo (file `index.html` harus di tingkat paling atas),
   impor ke Vercel dengan Framework Preset **Other**. Di Settings > Environment Variables isi:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = secret key (rahasia, jangan dibagikan)
6. Buka alamat Vercel, masuk dengan username `owner` (atau email lengkap bila memakai email lain).
7. Punya data dari Lucky Bienie lama? **Pengaturan > Backup & restore > Restore** dengan file cadangan lama.
   Setelah itu data muncul di semua HP.
8. Tambah kasir di menu **Pengguna**. Mereka cukup login di HP masing-masing.

## APK
Buka https://www.pwabuilder.com, masukkan alamat Vercel, pilih Package for stores > Android.
Simpan file keystore dan sandinya. Taruh `assetlinks.json` hasil PWABuilder di `.well-known/assetlinks.json`
agar bilah alamat hilang.

## Cara kerja sinkron
- Setiap perubahan disimpan di perangkat lalu dikirim ke cloud; HP lain menerimanya otomatis (real-time).
- Offline: transaksi tetap jalan, terkirim saat online. Stok digabung sebagai selisih sehingga dua HP yang
  menjual produk sama tidak saling menimpa. Nomor nota offline diberi akhiran kode perangkat agar tidak kembar.
- Shift kasir bersifat bersama (satu laci kas untuk semua HP).
- Konsolidasi antar outlet tetap memakai file cadangan, seperti sebelumnya.
- Tombol *Reset semua* diganti *Muat ulang dari cloud* agar data tidak terhapus tidak sengaja.
