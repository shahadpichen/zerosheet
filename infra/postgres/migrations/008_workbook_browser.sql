-- Folders are personal organization, not authorization or Google Drive ACLs.
-- A workbook can be placed differently by each collaborator. Names and IDs are
-- ordinary product metadata; protected cell contents never enter these tables.
BEGIN;
CREATE TABLE IF NOT EXISTS workspace_folders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES product_users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  parent_id uuid,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, parent_id) REFERENCES workspace_folders(user_id, id),
  CHECK (id <> parent_id)
);
CREATE INDEX IF NOT EXISTS workspace_folders_owner_idx ON workspace_folders(user_id);
CREATE TABLE IF NOT EXISTS workspace_workbook_locations (
  user_id uuid NOT NULL REFERENCES product_users(id),
  workbook_id uuid NOT NULL REFERENCES workbooks(id),
  folder_id uuid NOT NULL,
  PRIMARY KEY (user_id, workbook_id),
  FOREIGN KEY (user_id, folder_id) REFERENCES workspace_folders(user_id, id)
);
INSERT INTO schema_migrations(version) VALUES ('008_workbook_browser') ON CONFLICT DO NOTHING;
COMMIT;
