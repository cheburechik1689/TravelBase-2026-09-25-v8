-- Отметка обработки документа экстрактором знаний (scripts/extract-knowledge.mjs).

alter table raw_documents add column if not exists processed_at timestamptz;
create index if not exists raw_documents_unprocessed_idx on raw_documents (processed_at) where processed_at is null;
