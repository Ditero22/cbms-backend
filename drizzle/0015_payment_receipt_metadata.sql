-- Preserve existing receipts and retain their recorded local date.
alter table payments add column payment_date date;
update payments set payment_date = (created_at at time zone 'Asia/Manila')::date;
alter table payments alter column payment_date set not null;
alter table payments alter column payment_date set default (now() at time zone 'Asia/Manila')::date;
alter table payments add column external_reference text;
alter table payments add column notes text;
-- Legacy callers may omit a request key; new clients retain one across retries.
alter table payments add column request_key text unique;
create index payments_order_date_idx on payments(order_id, payment_date);
