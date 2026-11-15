-- Teams: one table for Jogadi (stitching) and Packing teams. The kind is fixed once made;
-- the code shows it (JG-001 / PT-002, one shared number sequence).
ALTER TABLE jogadi_teams
  ADD COLUMN kind text NOT NULL DEFAULT 'JOGADI' CONSTRAINT jogadi_teams_kind_check CHECK (kind IN ('JOGADI', 'PACKING'));

ALTER TABLE jogadi_teams DROP COLUMN code;
ALTER TABLE jogadi_teams
  ADD COLUMN code text GENERATED ALWAYS AS (
    (CASE kind WHEN 'PACKING' THEN 'PT-' ELSE 'JG-' END) || lpad(number::text, 3, '0')
  ) STORED;

CREATE INDEX jogadi_teams_kind_idx ON jogadi_teams (kind, active);

-- Team earnings now always split equally. Issued work keeps its own snapshot of shares.
UPDATE jogadi_members SET share_percent = NULL WHERE left_at IS NULL AND share_percent IS NOT NULL;

-- Packing by a packing team at a typed rate per piece. Entries made before this keep their
-- single packer; new ones name a team and freeze its members below.
ALTER TABLE packing_entries ALTER COLUMN packer_id DROP NOT NULL;
ALTER TABLE packing_entries ALTER COLUMN packer_name DROP NOT NULL;
ALTER TABLE packing_entries ADD COLUMN team_id uuid REFERENCES jogadi_teams (id);
ALTER TABLE packing_entries ADD COLUMN team_name text;
ALTER TABLE packing_entries
  ADD CONSTRAINT packing_entries_packed_by_check CHECK (
    num_nonnulls(packer_id, team_id) = 1
    AND (packer_id IS NULL) = (packer_name IS NULL)
    AND (team_id IS NULL) = (team_name IS NULL)
  );
CREATE INDEX packing_entries_team_idx ON packing_entries (team_id, pack_date) WHERE team_id IS NOT NULL;

-- The packing team as it was when the entry was posted; its earning was split equally over these people.
CREATE TABLE packing_entry_members (
  entry_id uuid NOT NULL REFERENCES packing_entries (id),
  karigar_id uuid NOT NULL REFERENCES karigars (id),
  karigar_name text NOT NULL,
  PRIMARY KEY (entry_id, karigar_id)
);
CREATE INDEX packing_entry_members_karigar_idx ON packing_entry_members (karigar_id);
