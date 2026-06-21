-- ============================================================================
-- OPTCG-Ledger — LIVE migration: legacy flat schema -> normalized schema
-- ============================================================================
-- Atomic: runs in one transaction. Legacy tables are RENAMED to legacy_* (not
-- dropped) so the migration is fully reversible and the original data is
-- retained as a backup. Final assertions RAISE (rolling back everything) if
-- row counts or contribution sums don't reconcile.
-- ============================================================================

-- 1. Park legacy tables as backup ------------------------------------------
alter table collections      rename to legacy_collections;
alter table entries          rename to legacy_entries;
alter table transactions     rename to legacy_transactions;
alter table sales            rename to legacy_sales;
alter table watchlist        rename to legacy_watchlist;
alter table card_aliases     rename to legacy_card_aliases;
alter table card_resolutions rename to legacy_card_resolutions;
alter table catalog_snapshot rename to legacy_catalog_snapshot;

-- 2. card-id parser ---------------------------------------------------------
create or replace function parse_card(p text,
  out set_code text, out serial text, out attribute_tag text, out is_card boolean)
language plpgsql immutable as $fn$
declare src text; rest text; m text[]; tail text; toks text[]; t text; attrs text[]:='{}';
begin
  is_card:=true;
  if p is null or p !~ '[A-Za-z]' or p ~ '^[0-9]+$' or p ~ '_p[0-9]+$' then
    is_card:=false; return; end if;
  rest:=p;
  if position(':' in rest)>0 then src:=split_part(rest,':',1); rest:=split_part(rest,':',2); end if;
  m:=regexp_match(rest,'^([A-Z]+[0-9]*)-([A-Za-z]?[0-9]+)');
  if m is null then is_card:=false; return; end if;
  serial:=m[1]||'-'||m[2];
  set_code:=coalesce(src,m[1]);
  tail:=substring(rest from length(serial)+1);
  toks:=string_to_array(trim(both '-' from tail),'-');
  if toks is not null then
    foreach t in array toks loop
      if t ~ '^[0-9]{4,}$' then continue;
      elsif t in ('parallel','manga','anniversary','championship','judge','dodgers','aniplex','pre','errata')
        then attrs:=attrs||t;
      end if;
    end loop;
  end if;
  if 'pre'=any(attrs) and 'errata'=any(attrs) then
    attrs:=array_remove(array_remove(attrs,'pre'),'errata')||array['pre-errata']; end if;
  select array_agg(x order by x) into attrs from unnest(attrs) x;
  attribute_tag:=coalesce(array_to_string(attrs,'-'),'');
end$fn$;

-- 3. New schema -------------------------------------------------------------
create table tcgs (
  tcg_code text primary key, name text not null, creator text, source_url text,
  source_kind text not null default 'tcgcsv', source_config jsonb not null default '{}'::jsonb,
  release_date date, date_added timestamptz not null default now());

create table grades (
  grade_code text primary key, company text, company_nickname text,
  grade_value text, description text, sort_rank int);

create table sets (
  set_code text primary key, tcg_code text not null references tcgs(tcg_code) on delete cascade,
  name text, release_date date, source_group_id text, sort_bucket int,
  created_at timestamptz not null default now());
create index on sets (tcg_code);

create table cards (
  card_code text primary key, set_code text not null references sets(set_code) on delete cascade,
  serial text not null, name text, full_name text, image_url text, rarity text,
  traits jsonb not null default '{}'::jsonb, attribute_tag text, external_id text,
  source text not null default 'tcgplayer', created_at timestamptz not null default now());
create index on cards (set_code);
create index on cards (serial);
create index on cards (external_id);
create index on cards using gin (traits);

create table card_variants (
  variant_key text primary key, label text not null, detect_regex text, sale_regex text,
  is_builtin boolean not null default false, tcg_code text references tcgs(tcg_code) on delete cascade);

create table sales (
  id uuid primary key default gen_random_uuid(),
  card_code text references cards(card_code) on delete set null,
  grade_code text references grades(grade_code) on delete set null,
  cert_number text, listing_site text not null, listing_url text, listing_title text,
  sale_date date not null, sale_price numeric not null, currency text not null default 'USD',
  sale_type text, post_date date, num_bids int, description text,
  source text not null default 'manual', ingested_by_vault text,
  created_at timestamptz not null default now(), unique (source, listing_url));
create index on sales (card_code, grade_code, sale_date desc);
create index on sales (sale_date desc);

create table collections (
  id uuid primary key default gen_random_uuid(), vault_key text not null, name text not null,
  tcg_code text references tcgs(tcg_code), members jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), unique (vault_key, name));
create index on collections (vault_key);

create table collected_cards (
  id uuid primary key default gen_random_uuid(), vault_key text not null,
  collection_id uuid references collections(id) on delete cascade,
  card_code text not null references cards(card_code),
  grade_code text references grades(grade_code), cert_number text, condition text, owner_name text,
  price_paid numeric not null default 0, acquisition_notes text, date_acquired date,
  date_sold date, sold_price numeric, graded_price numeric, graded_price_source text,
  graded_price_fetched_at timestamptz, grade_description text, psa_spec_id text,
  added_at timestamptz not null default now(), created_at timestamptz not null default now());
create index on collected_cards (vault_key);
create index on collected_cards (vault_key, collection_id);
create index on collected_cards (card_code);
create index on collected_cards (vault_key, date_sold);

create table contributions (
  id uuid primary key default gen_random_uuid(), vault_key text not null,
  collected_card_id uuid not null references collected_cards(id) on delete cascade,
  member_name text not null, amount numeric not null, created_at timestamptz not null default now());
create index on contributions (vault_key);
create index on contributions (collected_card_id);

create table transactions (
  id uuid primary key default gen_random_uuid(), vault_key text not null,
  collection_id uuid references collections(id) on delete set null,
  collected_card_id uuid references collected_cards(id) on delete set null,
  card_code text references cards(card_code), card_display_name text, type text not null,
  amount numeric not null default 0, occurred_at date, notes text,
  created_at timestamptz not null default now());
create index on transactions (vault_key);
create index on transactions (collected_card_id);
create index on transactions (vault_key, type);

create table transaction_contributions (
  id uuid primary key default gen_random_uuid(), vault_key text not null,
  transaction_id uuid not null references transactions(id) on delete cascade,
  member_name text not null, amount numeric not null, created_at timestamptz not null default now());
create index on transaction_contributions (transaction_id);

create table card_nicknames (
  id uuid primary key default gen_random_uuid(), vault_key text not null,
  card_code text not null references cards(card_code) on delete cascade,
  nickname text not null, created_at timestamptz not null default now(),
  unique (vault_key, card_code, nickname));
create index on card_nicknames (vault_key, lower(nickname));

-- 4. Reference seed: tcg + grades ------------------------------------------
insert into tcgs(tcg_code,name,creator,source_url,source_kind,source_config)
values ('OP','One Piece Card Game','Bandai','https://tcgcsv.com','tcgcsv','{"categoryId":68}'::jsonb);

insert into grades(grade_code, company, company_nickname, grade_value)
select distinct
  case when gc is null then 'RAW' when bl then 'BGS BL' else gc||' '||vtxt end,
  case gc when 'PSA' then 'Professional Sports Authenticator'
          when 'BGS' then 'Beckett Grading Services'
          when 'CGC' then 'Certified Guaranty Company' else null end,
  gc,
  case when gc is null then null when bl then 'Black Label' else vtxt end
from (
  select grading_company gc, bgs_black bl,
    case when grade=trunc(grade) then trunc(grade)::int::text else grade::text end vtxt
  from legacy_entries
  union
  select grading_company, bgs_black,
    case when grade=trunc(grade) then trunc(grade)::int::text else grade::text end
  from legacy_sales
) u
on conflict (grade_code) do nothing;

-- 5. Catalog: synthesize sets + cards for every referenced card id ----------
create temp table _universe on commit drop as
select distinct cid as card_id, (parse_card(cid)).set_code,
       (parse_card(cid)).serial, (parse_card(cid)).attribute_tag
from (
  select card_id cid from legacy_entries where card_id is not null
  union select card_id from legacy_transactions where card_id is not null
  union select card_id from legacy_sales where card_id is not null
  union select card_id from legacy_card_aliases where card_id is not null
) s
where (parse_card(cid)).is_card;

insert into sets(set_code, tcg_code)
select distinct set_code, 'OP' from _universe where set_code is not null
on conflict (set_code) do nothing;

insert into cards(card_code, set_code, serial, attribute_tag, source)
select card_id, set_code, serial, attribute_tag, 'legacy-migrated' from _universe
on conflict (card_code) do nothing;

-- helper: grade_code expression reused below
-- 6. Collections ------------------------------------------------------------
insert into collections(id, vault_key, name, members, created_at)
select id, vault_key, name, coalesce(members,'[]'::jsonb), created_at from legacy_collections;

-- 7. Collected cards: live entries -----------------------------------------
insert into collected_cards(id, vault_key, collection_id, card_code, grade_code, cert_number,
  condition, owner_name, price_paid, acquisition_notes, date_acquired, graded_price,
  graded_price_source, graded_price_fetched_at, grade_description, psa_spec_id, added_at)
select e.id, e.vault_key, e.collection_id, e.card_id,
  case when e.grading_company is null then 'RAW' when e.bgs_black then 'BGS BL'
       else e.grading_company||' '||(case when e.grade=trunc(e.grade) then trunc(e.grade)::int::text else e.grade::text end) end,
  e.cert_number, e.condition, e.owner_name, coalesce(e.purchase_price,0), e.notes, e.acquired_at,
  e.graded_price, e.graded_price_source, e.graded_price_fetched_at, e.grade_description, e.psa_spec_id, e.added_at
from legacy_entries e;

-- 8. Collected cards: reconstruct deleted SOLD entries from buy+sell tx -----
insert into collected_cards(id, vault_key, collection_id, card_code, cert_number, price_paid,
  acquisition_notes, date_acquired, date_sold, sold_price, added_at)
select distinct on (s.entry_id)
  s.entry_id::uuid, s.vault_key, b.collection_id, b.card_id, null,
  coalesce(b.amount,0), b.notes, b.occurred_at, s.occurred_at, s.amount, coalesce(b.created_at, now())
from legacy_transactions s
join legacy_transactions b on b.entry_id = s.entry_id and b.type='buy'
where s.type='sell' and s.entry_id is not null
  and s.entry_id not in (select id::text from legacy_entries)
order by s.entry_id, b.occurred_at;

-- 9. Contributions: live entries + reconstructed sold ----------------------
insert into contributions(vault_key, collected_card_id, member_name, amount)
select e.vault_key, e.id, el->>'name', (el->>'amount')::numeric
from legacy_entries e
cross join lateral jsonb_array_elements(coalesce(e.contributions,'[]'::jsonb)) el;

insert into contributions(vault_key, collected_card_id, member_name, amount)
select b.vault_key, s.entry_id::uuid, el->>'name', (el->>'amount')::numeric
from legacy_transactions s
join legacy_transactions b on b.entry_id = s.entry_id and b.type='buy'
cross join lateral jsonb_array_elements(coalesce(b.contributions,'[]'::jsonb)) el
where s.type='sell' and s.entry_id is not null
  and s.entry_id not in (select id::text from legacy_entries);

-- 10. Transactions ----------------------------------------------------------
insert into transactions(id, vault_key, collection_id, collected_card_id, card_code,
  card_display_name, type, amount, occurred_at, notes, created_at)
select t.id, t.vault_key, t.collection_id, cc.id,
  case when (parse_card(t.card_id)).is_card then t.card_id else null end,
  t.card_display_name, t.type, t.amount, t.occurred_at, t.notes, t.created_at
from legacy_transactions t
left join collected_cards cc on cc.id = nullif(t.entry_id,'')::uuid;

insert into transaction_contributions(vault_key, transaction_id, member_name, amount)
select t.vault_key, t.id, el->>'name', (el->>'amount')::numeric
from legacy_transactions t
cross join lateral jsonb_array_elements(coalesce(t.contributions,'[]'::jsonb)) el;

-- 11. Card nicknames --------------------------------------------------------
insert into card_nicknames(vault_key, card_code, nickname)
select vault_key, card_id, alias from legacy_card_aliases
on conflict (vault_key, card_code, nickname) do nothing;

-- 12. Sales -----------------------------------------------------------------
insert into sales(id, card_code, grade_code, cert_number, listing_site, listing_url,
  listing_title, sale_date, sale_price, currency, description, source, ingested_by_vault, created_at)
select s.id, s.card_id,
  case when s.grading_company is null then 'RAW' when s.bgs_black then 'BGS BL'
       else s.grading_company||' '||(case when s.grade=trunc(s.grade) then trunc(s.grade)::int::text else s.grade::text end) end,
  s.cert_number, coalesce(s.marketplace,'unknown'), s.listing_url, s.listing_title,
  s.sale_date, s.sale_price, coalesce(s.currency,'USD'), s.notes, coalesce(s.source,'manual'),
  s.vault_key, s.created_at
from legacy_sales s;

-- 13. RLS: enable + permissive (match legacy posture) ----------------------
do $rls$
declare tbl text;
begin
  foreach tbl in array array['tcgs','grades','sets','cards','card_variants','sales',
    'collections','collected_cards','contributions','transactions','transaction_contributions','card_nicknames']
  loop
    execute format('alter table %I enable row level security', tbl);
    execute format('create policy %I on %I for all using (true) with check (true)', tbl||'_all', tbl);
  end loop;
end$rls$;

-- 14. Validation: RAISE (roll back everything) on any mismatch --------------
do $chk$
declare
  v_cc int; v_cc_expect int; v_tx int; v_tx_src int; v_sales int; v_sales_src int;
  v_unmapped int; v_contrib numeric; v_contrib_src numeric;
begin
  select count(*) into v_cc from collected_cards;
  select (select count(*) from legacy_entries)
       + (select count(distinct entry_id) from legacy_transactions
          where type='sell' and entry_id is not null and entry_id not in (select id::text from legacy_entries))
    into v_cc_expect;
  if v_cc <> v_cc_expect then raise exception 'collected_cards % <> expected %', v_cc, v_cc_expect; end if;

  select count(*) into v_tx from transactions;
  select count(*) into v_tx_src from legacy_transactions;
  if v_tx <> v_tx_src then raise exception 'transactions % <> legacy %', v_tx, v_tx_src; end if;

  select count(*) into v_sales from sales;
  select count(*) into v_sales_src from legacy_sales;
  if v_sales <> v_sales_src then raise exception 'sales % <> legacy %', v_sales, v_sales_src; end if;

  select count(*) into v_unmapped from legacy_transactions t
   where t.entry_id is not null and not exists (select 1 from collected_cards c where c.id=nullif(t.entry_id,'')::uuid);
  if v_unmapped <> 0 then raise exception '% tx have entry_id with no collected_card', v_unmapped; end if;

  select coalesce(sum(amount),0) into v_contrib from contributions;
  select (select coalesce(sum((el->>'amount')::numeric),0)
          from legacy_entries e cross join lateral jsonb_array_elements(coalesce(e.contributions,'[]'::jsonb)) el)
       + (select coalesce(sum((el->>'amount')::numeric),0)
          from legacy_transactions s join legacy_transactions b on b.entry_id=s.entry_id and b.type='buy'
          cross join lateral jsonb_array_elements(coalesce(b.contributions,'[]'::jsonb)) el
          where s.type='sell' and s.entry_id is not null and s.entry_id not in (select id::text from legacy_entries))
    into v_contrib_src;
  if v_contrib <> v_contrib_src then raise exception 'contrib sum % <> expected %', v_contrib, v_contrib_src; end if;

  raise notice 'VALIDATION OK: collected_cards=%, transactions=%, sales=%, contrib_sum=%', v_cc, v_tx, v_sales, v_contrib;
end$chk$;
