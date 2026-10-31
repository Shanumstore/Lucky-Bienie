-- =====================================================================
-- LUCKY BIENIE CLOUD - Skema database (Supabase / PostgreSQL)
-- Jalankan SEKALI di Supabase > SQL Editor.
-- Disarankan memakai proyek Supabase BARU khusus Lucky Bienie.
-- =====================================================================

-- ---------- Profil pengguna (menempel ke auth.users) ----------
create table if not exists lb_profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  username   text not null,
  name       text not null default '',
  role       text not null default 'kasir' check (role in ('owner','manajer','kasir','auditor','akuntan')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Akun PERTAMA yang dibuat otomatis menjadi owner.
-- Akun berikutnya hanya dibuat oleh Owner lewat aplikasi (role dibaca dari app_metadata,
-- yang hanya bisa diisi server, jadi tidak bisa dipalsukan lewat pendaftaran sendiri).
create or replace function lb_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  first_user := not exists (select 1 from lb_profiles);
  if not first_user and (new.raw_app_meta_data->>'lb_role') is null then
    return new;   -- bukan akun Lucky Bienie
  end if;
  insert into lb_profiles (id, email, username, name, role, active)
  values (
    new.id, new.email,
    lower(coalesce(new.raw_app_meta_data->>'lb_username', split_part(new.email, '@', 1))),
    coalesce(new.raw_app_meta_data->>'lb_name', split_part(new.email, '@', 1)),
    case when first_user then 'owner' else coalesce(new.raw_app_meta_data->>'lb_role', 'kasir') end,
    coalesce((new.raw_app_meta_data->>'lb_active')::boolean, true)
  ) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists lb_on_auth_user_created on auth.users;
create trigger lb_on_auth_user_created after insert on auth.users
  for each row execute function lb_handle_new_user();

create or replace function lb_role() returns text
language sql stable security definer set search_path = public as $$
  select role from lb_profiles where id = auth.uid() and active;
$$;

-- ---------- Data bisnis: satu baris per catatan ----------
-- collection: products, sales, held, shifts, sup, cus, buys, exps, pays, mv, rets,
--             audit, promos, jm, lp, dan _cfg / _shift / _n (pengaturan, shift, penomoran)
create table if not exists lb_records (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (collection, id)
);
create index if not exists idx_lb_records_updated on lb_records (updated_at);

-- Catatan operasi yang sudah diproses (mencegah pengiriman ganda saat koneksi putus-nyambung)
create table if not exists lb_ops (
  id text primary key,
  at timestamptz not null default now()
);

alter table lb_profiles enable row level security;
alter table lb_records  enable row level security;
alter table lb_ops      enable row level security;

create policy lb_profiles_read on lb_profiles for select
  using (id = auth.uid() or lb_role() = 'owner');
create policy lb_records_read on lb_records for select
  using (lb_role() is not null);
-- Tidak ada policy tulis: semua penulisan lewat fungsi lb_push() di bawah.

revoke all on lb_records, lb_profiles, lb_ops from anon, authenticated;
grant select on lb_records, lb_profiles to authenticated;

-- ---------- Penulisan data (atomik, mendukung penambah/pengurang stok) ----------
-- p_items: [{c, id, data, del, po, d}]
--   del = hapus (soft delete) | po = hanya ubah penghitung | d = selisih penghitung (mis. stok -2)
create or replace function lb_push(p_bid text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_role text;
  it jsonb; c text; rid text; cur jsonb; nd jsonb; k text; dv numeric; n int := 0;
begin
  v_role := lb_role();
  if v_role is null then raise exception 'Tidak berwenang'; end if;

  if p_bid is not null then
    insert into lb_ops (id) values (p_bid) on conflict do nothing;
    if not found then return jsonb_build_object('dup', true); end if;
  end if;
  if random() < 0.02 then delete from lb_ops where at < now() - interval '14 days'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    c := it->>'c'; rid := it->>'id';
    if c not in ('products','sales','held','shifts','sup','cus','buys','exps','pays','mv','rets',
                 'audit','promos','jm','lp','_cfg','_shift','_n') then
      raise exception 'Koleksi tidak dikenal: %', c;
    end if;
    if v_role = 'auditor' then raise exception 'Role auditor hanya bisa melihat data'; end if;
    if v_role = 'akuntan' and c not in ('jm','audit') then raise exception 'Role akuntan hanya boleh menulis jurnal'; end if;
    if c = '_cfg' and v_role <> 'owner' then raise exception 'Hanya owner yang boleh mengubah pengaturan'; end if;

    select data into cur from lb_records where collection = c and id = rid for update;

    if coalesce((it->>'del')::boolean, false) then
      update lb_records set data = '{}'::jsonb, deleted = true, updated_at = now(), updated_by = v_uid
       where collection = c and id = rid;
    else
      if coalesce((it->>'po')::boolean, false) and cur is not null then
        nd := cur;
      else
        nd := coalesce(it->'data', '{}'::jsonb);
      end if;
      if cur is not null and (it->'d') is not null and jsonb_typeof(it->'d') = 'object' then
        for k, dv in select key, value::numeric from jsonb_each_text(it->'d') loop
          nd := jsonb_set(nd, array[k], to_jsonb(coalesce((cur->>k)::numeric, 0) + dv));
        end loop;
      end if;
      insert into lb_records (collection, id, data, deleted, updated_by)
      values (c, rid, nd, false, v_uid)
      on conflict (collection, id) do update
        set data = excluded.data, deleted = false, updated_at = now(), updated_by = excluded.updated_by;
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('n', n);
end $$;

revoke all on function lb_push(text, jsonb) from public;
grant execute on function lb_push(text, jsonb) to authenticated;

-- ---------- Real-time antar perangkat ----------
do $$ begin
  alter publication supabase_realtime add table lb_records;
exception when duplicate_object then null;
end $$;
